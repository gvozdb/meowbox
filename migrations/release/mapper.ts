import { readFile } from 'node:fs/promises';

import { DEFAULT_IGNORED_SCHEMA_OBJECTS, fingerprintDatabase } from './fingerprint';
import { redactDiagnostics } from './redaction';
import { columnNumber, columnString, querySqliteJson, quoteIdentifier, quoteLiteral, runSqliteScript } from './sqlite';
import { fingerprintDatabaseFiles, sha256Json } from './stable';
import { blocker, reportOk, warning, type DatabaseWriteMode, type Diagnostic, type JsonObject, type JsonValue } from './types';
import {
  deriveSecondaryRuntimeKey,
  isModxPreset,
  isRelativePathContained,
  isSafeRuntimeKey,
  KNOWN_PRESETS,
  normalizeHostname,
  normalizeRelativePath,
  parseAliases,
  socketPathWithinLimit,
} from './validation';

export const DEFAULT_MAP_TABLE = '_meowbox_domain_migration_map';
export const DEFAULT_TARGET_MIGRATION = 'domain_centric_applications';

/**
 * These values are deliberately the same values consumed by the Prisma
 * table-copy migration.  Do not introduce an internal spelling here: this is
 * the persisted, versioned staging-table contract.
 */
export type MapRecordKind = 'SITE' | 'DOMAIN' | 'DATABASE';

export interface RuntimeEvidenceEntry {
  /** Observed from the current generated Nginx runtime, never inferred. */
  readonly phpEnabled?: boolean;
  /** Database name from a read-only managed MODX configuration parser. */
  readonly modxDatabaseName?: string;
  /** Effective legacy Site pool ceiling observed from its generated pool. */
  readonly poolMaxChildren?: number;
}

export interface RuntimeEvidence {
  readonly domains: Readonly<Record<string, RuntimeEvidenceEntry>>;
}

export interface MigrationMapRow {
  readonly recordKind: MapRecordKind;
  readonly sourceId: string;
  readonly sourceSiteId: string;
  readonly sourceDomainId: string | null;
  readonly sourceDatabaseId: string | null;
  readonly rowSha256: string;
  /** Only filesystem-assisted facts; no credentials, env vars, or raw config. */
  readonly payload: JsonObject;
}

/**
 * Private values destined for the staging table.  They deliberately live in
 * a WeakMap rather than the public report envelope: pool custom directives
 * and a preserved application error can be needed by the SQL copy, but must
 * never leak into the redacted dry-run report.
 */
interface StagingMapPayload {
  readonly primarySiteDomainId: string;
  readonly preset: string | null;
  readonly appStatus: string | null;
  readonly appErrorMessage: string | null;
  readonly filesRelPath: string | null;
  readonly phpVersion: string | null;
  readonly phpPoolCustom: string | null;
  readonly runtimeKey: string | null;
  readonly appPort: number | null;
  readonly purpose: string | null;
}

const stagingPayloads = new WeakMap<MigrationMapRow, StagingMapPayload>();

export interface MigrationMapEnvelope {
  readonly version: 1;
  readonly targetMigration: string;
  /** Stable checksum of the source mapping inputs (excludes the staging table). */
  readonly sourceDbSha256: string;
  /** Durable SQLite main/WAL checksum observed before this read-only map. */
  readonly sourceFileSha256: string;
  readonly sourceSchemaSha256: string;
  readonly rows: readonly MigrationMapRow[];
  readonly mapSha256: string;
}

export interface LegacyMapReport {
  readonly ok: boolean;
  readonly envelope: MigrationMapEnvelope;
  readonly blockers: readonly Diagnostic[];
  readonly warnings: readonly Diagnostic[];
}

export interface BuildLegacyMapOptions {
  readonly dbPath: string;
  readonly mapTable?: string;
  readonly targetMigration?: string;
  readonly runtimeEvidence?: RuntimeEvidence;
  readonly socketDirectory?: string;
  readonly socketMaxBytes?: number;
}

export interface ApplyLegacyMapOptions extends BuildLegacyMapOptions {
  readonly writeMode: DatabaseWriteMode;
}

export interface ApplyLegacyMapResult {
  readonly report: LegacyMapReport;
  readonly changed: boolean;
}

interface LegacySite {
  readonly id: string;
  readonly name: string;
  readonly preset: string;
  readonly status: string;
  readonly errorMessage: string | null;
  readonly rootPath: string;
  readonly filesRelPath: string | null;
  readonly appPort: number | null;
  readonly phpVersion: string | null;
  readonly phpPoolCustom: string | null;
}

interface LegacyDomain {
  readonly id: string;
  readonly siteId: string;
  readonly domain: string;
  readonly isPrimary: boolean;
  readonly position: number;
  readonly aliases: string;
  readonly filesRelPath: string | null;
  readonly appPort: number | null;
}

interface LegacyDatabase {
  readonly id: string;
  readonly siteId: string | null;
  readonly name: string;
  readonly type: string;
  readonly dbUser: string | null;
  readonly siteDomainId: string | null;
  readonly purpose: string | null;
}

interface SelectedPrimaryDatabase {
  readonly database: LegacyDatabase | null;
  readonly ambiguity: boolean;
}

interface TableColumns {
  readonly exists: boolean;
  readonly columns: ReadonlySet<string>;
}

function mapTableName(value: string | undefined): string {
  const table = value ?? DEFAULT_MAP_TABLE;
  if (!/^_[a-z0-9_]+$/.test(table)) throw new Error('map-table must be an underscore-prefixed lowercase SQLite identifier');
  return table;
}

function targetMigrationName(value: string | undefined): string {
  const target = value ?? DEFAULT_TARGET_MIGRATION;
  if (!/^[A-Za-z0-9_.-]+$/.test(target)) throw new Error('target migration contains unsupported characters');
  if (target !== DEFAULT_TARGET_MIGRATION) {
    throw new Error(`Unsupported staging-map target migration: ${target}`);
  }
  return target;
}

function requiredText(row: JsonObject, column: string): string | null {
  const value = columnString(row, column);
  return value === null || value.length === 0 ? null : value;
}

function optionalInteger(row: JsonObject, column: string): number | null {
  const value = columnNumber(row, column);
  if (value === null || !Number.isInteger(value)) return value === null ? null : Number.NaN;
  return value;
}

function validPort(value: number | null): boolean {
  return value === null || (Number.isInteger(value) && value >= 1 && value <= 65_535);
}

function booleanValue(row: JsonObject, column: string): boolean | null {
  const value = row[column];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && (value === 0 || value === 1)) return value === 1;
  return null;
}

function hasColumn(columns: TableColumns, column: string): boolean {
  return columns.exists && columns.columns.has(column);
}

async function tableColumns(dbPath: string, table: string): Promise<TableColumns> {
  const existsRows = await querySqliteJson(
    dbPath,
    `SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ${quoteLiteral(table)} LIMIT 1;`,
  );
  if (existsRows.length === 0) return { exists: false, columns: new Set() };
  const rows = await querySqliteJson(dbPath, `PRAGMA table_xinfo(${quoteIdentifier(table)});`);
  return {
    exists: true,
    columns: new Set(rows.map((row) => row.name).filter((value): value is string => typeof value === 'string')),
  };
}

function selectExpression(columns: TableColumns, source: string, alias: string): string {
  return hasColumn(columns, source)
    ? `${quoteIdentifier(source)} AS ${quoteIdentifier(alias)}`
    : `NULL AS ${quoteIdentifier(alias)}`;
}

async function selectRows(
  dbPath: string,
  table: string,
  columns: TableColumns,
  fields: readonly string[],
): Promise<readonly JsonObject[]> {
  const selectList = fields.map((field) => selectExpression(columns, field, field)).join(', ');
  return querySqliteJson(dbPath, `SELECT ${selectList} FROM ${quoteIdentifier(table)} ORDER BY ${quoteIdentifier('id')};`);
}

function requiredColumns(table: string, columns: TableColumns, required: readonly string[], blockers: Diagnostic[]): boolean {
  if (!columns.exists) {
    blockers.push(blocker('LEGACY_TABLE_MISSING', 'Supported legacy schema is missing a required table', { table }));
    return false;
  }
  const missing = required.filter((column) => !columns.columns.has(column));
  if (missing.length > 0) {
    blockers.push(blocker('LEGACY_SCHEMA_MISSING_COLUMN', 'Supported legacy schema is missing required mapping columns', { table, missingColumns: [...missing] }));
    return false;
  }
  return true;
}

function sortMapRows(rows: readonly MigrationMapRow[]): readonly MigrationMapRow[] {
  const order: Record<MapRecordKind, number> = { SITE: 0, DOMAIN: 1, DATABASE: 2 };
  return [...rows].sort((left, right) => order[left.recordKind] - order[right.recordKind]
    || left.sourceId.localeCompare(right.sourceId));
}

function mapHash(targetMigration: string, sourceDbSha256: string, sourceSchemaSha256: string, rows: readonly MigrationMapRow[]): string {
  return sha256Json({ version: 1, targetMigration, sourceDbSha256, sourceSchemaSha256, rows: rows as unknown as JsonValue });
}

function sameFileFingerprint(left: string, right: string): boolean {
  return left === right;
}

function exactlyOne(candidates: readonly LegacyDatabase[]): SelectedPrimaryDatabase {
  if (candidates.length === 1) return { database: candidates[0], ambiguity: false };
  return { database: null, ambiguity: candidates.length > 1 };
}

/** Implements the exact, ordered legacy primary-database resolver from W07. */
function resolvePrimaryDatabase(
  site: LegacySite,
  primaryDomain: LegacyDomain,
  databases: readonly LegacyDatabase[],
  evidence: RuntimeEvidenceEntry | undefined,
): SelectedPrimaryDatabase {
  const mysqlCompatible = (database: LegacyDatabase): boolean => database.type === 'MARIADB' || database.type === 'MYSQL';
  const persisted = databases.filter((database) =>
    database.siteDomainId === primaryDomain.id && database.purpose === 'APP_PRIMARY' && mysqlCompatible(database),
  );
  const persistedResult = exactlyOne(persisted);
  if (persistedResult.database !== null || persistedResult.ambiguity) return persistedResult;

  const installer = databases.filter((database) =>
    mysqlCompatible(database) && database.name === site.name && database.dbUser === site.name,
  );
  const installerResult = exactlyOne(installer);
  if (installerResult.database !== null || installerResult.ambiguity) return installerResult;

  const modxDatabaseName = evidence?.modxDatabaseName;
  if (modxDatabaseName !== undefined) {
    const configMatches = databases.filter((database) => mysqlCompatible(database) && database.name === modxDatabaseName);
    const configResult = exactlyOne(configMatches);
    if (configResult.database !== null || configResult.ambiguity) return configResult;
  }

  const sole = databases.filter(mysqlCompatible);
  return exactlyOne(sole);
}

function sourceRowHash(value: JsonObject): string {
  return sha256Json(value);
}

function mapAppStatus(site: LegacySite): 'RUNNING' | 'ERROR' {
  // A nullable old error text does not turn an explicit legacy ERROR state
  // into a fabricated RUNNING application.  The table-copy contract permits
  // app_error_message to remain null.
  return site.status === 'ERROR' ? 'ERROR' : 'RUNNING';
}

const SENSITIVE_STAGING_VALUE = /(?:password|passwd|secret|token|credential|authorization|cookie|private[_-]?key|ssh[_-]?key|env\s*\[[^\]]*(?:pass|secret|token|key)[^\]]*\])/i;
const URI_WITH_CREDENTIALS = /[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+(?::[^\s/@]*)?@/i;
const MAX_PHP_POOL_CUSTOM_BYTES = 16 * 1024;
const MAX_PHP_POOL_CUSTOM_LINE_BYTES = 2 * 1024;
const PHP_POOL_DIRECTIVE = /^([A-Za-z][A-Za-z0-9_.-]*(?:\[[A-Za-z][A-Za-z0-9_.-]{0,80}\])?)\s*=\s*(.*)$/;
const PHP_POOL_ALLOWED_DIRECTIVE = /^(?:php_(?:admin_)?(?:value|flag)\[[A-Za-z0-9_.-]{1,80}\]|env\[(?:PATH|HOME|TMP|TMPDIR|TEMP)\]|clear_env|catch_workers_output|decorate_workers_output|request_terminate_timeout)$/;
const PHP_POOL_IDENTITY_OR_RESOURCE_DIRECTIVE = /^(?:listen(?:\.|$)|user$|group$|pm(?:\.|$)|prefix$|include$|chroot$|chdir$|rlimit_(?:core|files)$|access\.log$|slowlog$|request_slowlog_timeout$)$/i;
const PHP_POOL_AGENT_OWNED_VALUES = new Set([
  'error_log',
  'sys_temp_dir',
  'upload_tmp_dir',
  'session.save_path',
  'open_basedir',
]);

interface SafePoolCustom {
  readonly nonResource: string | null;
  readonly configuredMaxChildren: number | null;
}

function poolBooleanValueIsSafe(key: string, value: string): boolean {
  const normalizedKey = key.toLowerCase();
  const normalized = value.trim().toLowerCase();
  if (normalizedKey === 'clear_env') return normalized === 'yes';
  if (normalizedKey === 'catch_workers_output' || normalizedKey === 'decorate_workers_output') {
    return normalized === 'yes' || normalized === 'no';
  }
  if (normalizedKey === 'request_terminate_timeout') {
    const parsed = /^(\d{1,7})([smhdw]?)$/.exec(normalized);
    if (!parsed) return false;
    const amount = Number(parsed[1]);
    const multiplier = {
      '': 1,
      s: 1,
      m: 60,
      h: 60 * 60,
      d: 24 * 60 * 60,
      w: 7 * 24 * 60 * 60,
    }[parsed[2]];
    return multiplier !== undefined
      && amount * multiplier <= 31 * 24 * 60 * 60;
  }
  return true;
}

function isAgentOwnedPhpValue(key: string): boolean {
  const match = /^php_(?:admin_)?(?:value|flag)\[([^\]]+)\]$/i.exec(key);
  return match !== null
    && PHP_POOL_AGENT_OWNED_VALUES.has(match[1].trim().toLowerCase());
}

/**
 * The table-copy migration has to receive an exact pool value for its primary
 * domain.  A pool directive is nevertheless untrusted operator input; block
 * instead of writing a likely secret into the map.  This keeps the staging
 * table a transport for runtime facts, never credentials.
 */
function safePoolCustomOrBlock(site: LegacySite, blockers: Diagnostic[]): SafePoolCustom {
  const value = site.phpPoolCustom;
  if (value === null) return { nonResource: null, configuredMaxChildren: null };
  if (Buffer.byteLength(value, 'utf8') > MAX_PHP_POOL_CUSTOM_BYTES
    || value.includes('\u0000')
    || SENSITIVE_STAGING_VALUE.test(value)
    || URI_WITH_CREDENTIALS.test(value)) {
    blockers.push(blocker('PHP_POOL_CUSTOM_SECRET_OR_UNSAFE', 'Legacy PHP pool custom directives cannot be copied into the migration map safely', { siteId: site.id }));
    return { nonResource: null, configuredMaxChildren: null };
  }
  const retained: string[] = [];
  let configuredMaxChildren: number | null = null;
  for (const rawLine of value.split('\n')) {
    // A carriage return could hide a second directive from a line-oriented
    // validator. Keep the map byte-for-byte only for unambiguous UTF-8 text.
    if (rawLine.includes('\r') || Buffer.byteLength(rawLine, 'utf8') > MAX_PHP_POOL_CUSTOM_LINE_BYTES) {
      blockers.push(blocker('PHP_POOL_CUSTOM_DIRECTIVE_UNSAFE', 'Legacy PHP pool custom directives exceed the supported safe format', { siteId: site.id }));
      return { nonResource: null, configuredMaxChildren: null };
    }
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith(';') || line.startsWith('#')) {
      retained.push(rawLine);
      continue;
    }
    const parsed = PHP_POOL_DIRECTIVE.exec(line);
    if (!parsed) {
      blockers.push(blocker('PHP_POOL_CUSTOM_DIRECTIVE_UNSAFE', 'Legacy PHP pool custom directives must be simple allowlisted assignments', { siteId: site.id }));
      return { nonResource: null, configuredMaxChildren: null };
    }
    const [, key, directiveValue] = parsed;
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === 'pm.max_children') {
      const parsedLimit = /^\d+$/.test(directiveValue.trim())
        ? Number(directiveValue.trim())
        : Number.NaN;
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 1024) {
        blockers.push(blocker('PHP_POOL_MAX_CHILDREN_INVALID', 'Legacy pm.max_children is outside the supported range', { siteId: site.id }));
        return { nonResource: null, configuredMaxChildren: null };
      }
      configuredMaxChildren = parsedLimit;
      continue;
    }
    if (isAgentOwnedPhpValue(normalizedKey)) {
      continue;
    }
    if (PHP_POOL_IDENTITY_OR_RESOURCE_DIRECTIVE.test(key)) {
      blockers.push(blocker('PHP_POOL_CUSTOM_IDENTITY_OR_RESOURCE_OVERRIDE', 'Legacy PHP pool custom directives may not override pool identity, sockets, or process-manager limits', { siteId: site.id, directive: key }));
      return { nonResource: null, configuredMaxChildren: null };
    }
    if (!PHP_POOL_ALLOWED_DIRECTIVE.test(key) || !poolBooleanValueIsSafe(key, directiveValue)
      || /[\u0000-\u001f\u007f]/.test(directiveValue.replace(/\t/g, ''))) {
      blockers.push(blocker('PHP_POOL_CUSTOM_DIRECTIVE_UNSAFE', 'Legacy PHP pool custom directive is outside the migration allowlist', { siteId: site.id, directive: key }));
      return { nonResource: null, configuredMaxChildren: null };
    }
    retained.push(rawLine);
  }
  const nonResource = retained.join('\n').trim();
  return {
    nonResource: nonResource.length > 0 ? nonResource : null,
    configuredMaxChildren,
  };
}

/**
 * Preserve a bounded, non-secret application failure message.  A suspicious
 * message blocks the release instead of silently dropping user-visible state
 * or exposing credentials through the map.
 */
function safeAppErrorMessageOrBlock(site: LegacySite, blockers: Diagnostic[]): string | null {
  if (mapAppStatus(site) !== 'ERROR') return null;
  const value = site.errorMessage;
  if (value === null) return null;
  if (value.length > 2_000 || value.includes('\u0000') || SENSITIVE_STAGING_VALUE.test(value) || URI_WITH_CREDENTIALS.test(value)) {
    blockers.push(blocker('APP_ERROR_MESSAGE_SECRET_OR_UNSAFE', 'Legacy application error message cannot be copied into the migration map safely', { siteId: site.id }));
    return null;
  }
  return value;
}

function poolCustomWithAllocation(custom: string | null, maxChildren: number): string {
  return [custom?.trim() || '', `pm.max_children = ${maxChildren}`]
    .filter(Boolean)
    .join('\n');
}

function normalizedPathOrBlock(
  raw: string | null,
  site: LegacySite,
  domainId: string,
  blockers: Diagnostic[],
): string | null {
  if (raw === null) {
    blockers.push(blocker('FILES_REL_PATH_MISSING', 'A mapped domain has no explicit or inherited filesRelPath', { siteId: site.id, domainId }));
    return null;
  }
  const normalized = normalizeRelativePath(raw);
  if (typeof normalized !== 'string') {
    blockers.push(blocker(`FILES_REL_PATH_${normalized.code}`, normalized.message, { siteId: site.id, domainId }));
    return null;
  }
  if (!isRelativePathContained(site.rootPath, normalized)) {
    blockers.push(blocker('FILES_REL_PATH_ESCAPES_ROOT', 'filesRelPath does not resolve inside the Site root path', { siteId: site.id, domainId }));
    return null;
  }
  return normalized;
}

function addHostnameClaims(domain: LegacyDomain, claims: Map<string, string>, blockers: Diagnostic[]): void {
  const canonical = normalizeHostname(domain.domain);
  if (typeof canonical !== 'string') {
    blockers.push(blocker(`DOMAIN_${canonical.code}`, canonical.message, { domainId: domain.id }));
    return;
  }
  const aliases = parseAliases(domain.aliases);
  if (!aliases.ok) {
    blockers.push(blocker(`ALIASES_${aliases.failure.code}`, aliases.failure.message, { domainId: domain.id }));
    return;
  }
  for (const hostname of [canonical, ...aliases.hostnames]) {
    const owner = claims.get(hostname);
    if (owner !== undefined && owner !== domain.id) {
      blockers.push(blocker('HOSTNAME_CONFLICT', 'Canonical domain or alias conflicts with another SiteDomain', { hostname, domainId: domain.id, conflictingDomainId: owner }));
    } else {
      claims.set(hostname, domain.id);
    }
  }
}

function addMapRow(
  rows: MigrationMapRow[],
  recordKind: MapRecordKind,
  sourceId: string,
  sourceSiteId: string,
  sourceDomainId: string | null,
  sourceDatabaseId: string | null,
  source: JsonObject,
  payload: JsonObject,
  staging: StagingMapPayload,
): void {
  const row: MigrationMapRow = {
    recordKind,
    sourceId,
    sourceSiteId,
    sourceDomainId,
    sourceDatabaseId,
    rowSha256: sourceRowHash(source),
    payload,
  };
  stagingPayloads.set(row, staging);
  rows.push(row);
}

function stagingPayloadFor(row: MigrationMapRow): StagingMapPayload {
  const payload = stagingPayloads.get(row);
  if (payload === undefined) throw new Error('Migration map row is missing private staging payload');
  return payload;
}

/**
 * Build a deterministic map without changing the DB. It intentionally reads
 * only routing/ownership fields, never passwords, encrypted values or env.
 */
export async function buildLegacyMigrationMap(options: BuildLegacyMapOptions): Promise<LegacyMapReport> {
  const mapTable = mapTableName(options.mapTable);
  const targetMigration = targetMigrationName(options.targetMigration);
  const socketDirectory = options.socketDirectory ?? '/var/run/php';
  const socketMaxBytes = options.socketMaxBytes ?? 107;
  const blockers: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const rows: MigrationMapRow[] = [];
  let logicalSource: JsonValue = {};
  const firstFiles = await fingerprintDatabaseFiles(options.dbPath);
  const [schema, sitesColumns, domainsColumns, databasesColumns] = await Promise.all([
    fingerprintDatabase(options.dbPath, { ignoredObjects: [...DEFAULT_IGNORED_SCHEMA_OBJECTS, mapTable] }),
    tableColumns(options.dbPath, 'sites'),
    tableColumns(options.dbPath, 'site_domains'),
    tableColumns(options.dbPath, 'databases'),
  ]);

  const sitesReady = requiredColumns('sites', sitesColumns, ['id', 'name', 'type', 'status', 'root_path', 'files_rel_path'], blockers);
  const domainsReady = requiredColumns('site_domains', domainsColumns, ['id', 'site_id', 'domain', 'is_primary', 'position', 'aliases'], blockers);
  const databasesReady = requiredColumns('databases', databasesColumns, ['id', 'site_id', 'name', 'type'], blockers);

  if (sitesReady && domainsReady && databasesReady) {
    const [siteRows, domainRows, databaseRows] = await Promise.all([
      selectRows(options.dbPath, 'sites', sitesColumns, ['id', 'name', 'type', 'status', 'error_message', 'root_path', 'files_rel_path', 'app_port', 'php_version', 'php_pool_custom']),
      selectRows(options.dbPath, 'site_domains', domainsColumns, ['id', 'site_id', 'domain', 'is_primary', 'position', 'aliases', 'files_rel_path', 'app_port']),
      selectRows(options.dbPath, 'databases', databasesColumns, ['id', 'site_id', 'name', 'type', 'db_user', 'site_domain_id', 'purpose']),
    ]);
    logicalSource = {
      sites: siteRows as unknown as JsonValue,
      siteDomains: domainRows as unknown as JsonValue,
      databases: databaseRows as unknown as JsonValue,
    };

    const sites: LegacySite[] = [];
    const domains: LegacyDomain[] = [];
    const databases: LegacyDatabase[] = [];
    const siteIds = new Set<string>();
    const domainIds = new Set<string>();
    const databaseIds = new Set<string>();

    for (const row of siteRows) {
      const id = requiredText(row, 'id');
      const name = requiredText(row, 'name');
      const preset = requiredText(row, 'type');
      const status = requiredText(row, 'status');
      const rootPath = requiredText(row, 'root_path');
      const phpVersion = columnString(row, 'php_version');
      if (id === null || name === null || preset === null || status === null || rootPath === null) {
        blockers.push(blocker('LEGACY_SITE_ROW_INVALID', 'Legacy Site has a missing required mapping value'));
        continue;
      }
      if (siteIds.has(id)) blockers.push(blocker('LEGACY_SITE_DUPLICATE', 'Legacy Site ID is duplicated', { siteId: id }));
      siteIds.add(id);
      if (!KNOWN_PRESETS.has(preset)) blockers.push(blocker('LEGACY_SITE_PRESET_INVALID', 'Legacy Site preset is unsupported', { siteId: id }));
      if (!isSafeRuntimeKey(name)
        || (phpVersion !== null
          && !socketPathWithinLimit(name, socketDirectory, socketMaxBytes, phpVersion))) {
        blockers.push(blocker('PRIMARY_RUNTIME_KEY_INVALID', 'Migrated primary runtime key is unsafe or exceeds the socket limit', { siteId: id }));
      }
      sites.push({
        id,
        name,
        preset,
        status,
        errorMessage: columnString(row, 'error_message'),
        rootPath,
        filesRelPath: columnString(row, 'files_rel_path'),
        appPort: optionalInteger(row, 'app_port'),
        phpVersion,
        phpPoolCustom: columnString(row, 'php_pool_custom'),
      });
      if (!validPort(optionalInteger(row, 'app_port'))) {
        blockers.push(blocker('LEGACY_SITE_APP_PORT_INVALID', 'Legacy Site appPort is outside the valid TCP port range', { siteId: id }));
      }
    }

    const hostClaims = new Map<string, string>();
    for (const row of domainRows) {
      const id = requiredText(row, 'id');
      const siteId = requiredText(row, 'site_id');
      const domain = requiredText(row, 'domain');
      const aliases = columnString(row, 'aliases');
      const isPrimary = booleanValue(row, 'is_primary');
      const position = optionalInteger(row, 'position');
      if (id === null || siteId === null || domain === null || aliases === null || isPrimary === null || position === null || Number.isNaN(position)) {
        blockers.push(blocker('LEGACY_DOMAIN_ROW_INVALID', 'Legacy SiteDomain has a missing or invalid required mapping value'));
        continue;
      }
      if (domainIds.has(id)) blockers.push(blocker('LEGACY_DOMAIN_DUPLICATE', 'Legacy SiteDomain ID is duplicated', { domainId: id }));
      domainIds.add(id);
      const domainRecord: LegacyDomain = {
        id,
        siteId,
        domain,
        isPrimary,
        position,
        aliases,
        filesRelPath: columnString(row, 'files_rel_path'),
        appPort: optionalInteger(row, 'app_port'),
      };
      domains.push(domainRecord);
      addHostnameClaims(domainRecord, hostClaims, blockers);
      if (!validPort(domainRecord.appPort)) {
        blockers.push(blocker('LEGACY_DOMAIN_APP_PORT_INVALID', 'Legacy SiteDomain appPort is outside the valid TCP port range', { domainId: id }));
      }
    }

    for (const row of databaseRows) {
      const id = requiredText(row, 'id');
      const name = requiredText(row, 'name');
      const type = requiredText(row, 'type');
      if (id === null || name === null || type === null) {
        blockers.push(blocker('LEGACY_DATABASE_ROW_INVALID', 'Legacy Database has a missing required mapping value'));
        continue;
      }
      if (databaseIds.has(id)) blockers.push(blocker('LEGACY_DATABASE_DUPLICATE', 'Legacy Database ID is duplicated', { databaseId: id }));
      databaseIds.add(id);
      databases.push({
        id,
        siteId: columnString(row, 'site_id'),
        name,
        type,
        dbUser: columnString(row, 'db_user'),
        siteDomainId: columnString(row, 'site_domain_id'),
        purpose: columnString(row, 'purpose'),
      });
    }

    const domainsBySite = new Map<string, LegacyDomain[]>();
    const domainsById = new Map<string, LegacyDomain>();
    for (const domain of domains) {
      const list = domainsBySite.get(domain.siteId) ?? [];
      list.push(domain);
      domainsBySite.set(domain.siteId, list);
      domainsById.set(domain.id, domain);
      if (!siteIds.has(domain.siteId)) blockers.push(blocker('DOMAIN_SITE_NOT_FOUND', 'SiteDomain references a missing Site', { domainId: domain.id, siteId: domain.siteId }));
    }
    const databasesBySite = new Map<string, LegacyDatabase[]>();
    for (const database of databases) {
      if (database.siteId === null) {
        blockers.push(blocker('DATABASE_SITE_MISSING', 'Legacy Database cannot be domain-owned because its Site ownership is missing', { databaseId: database.id }));
        continue;
      }
      if (!siteIds.has(database.siteId)) {
        blockers.push(blocker('DATABASE_SITE_NOT_FOUND', 'Legacy Database references a missing Site', { databaseId: database.id, siteId: database.siteId }));
        continue;
      }
      const list = databasesBySite.get(database.siteId) ?? [];
      list.push(database);
      databasesBySite.set(database.siteId, list);
      if (database.siteDomainId !== null) {
        const referenced = domainsById.get(database.siteDomainId);
        if (referenced === undefined || referenced.siteId !== database.siteId) {
          blockers.push(blocker('DATABASE_DOMAIN_SITE_MISMATCH', 'Legacy Database domain relation is missing or belongs to a different Site', { databaseId: database.id }));
        }
      }
    }

    const runtimeKeys = new Map<string, string>();
    for (const site of [...sites].sort((left, right) => left.id.localeCompare(right.id))) {
      const appStatus = mapAppStatus(site);
      const safePhpPoolCustom = safePoolCustomOrBlock(site, blockers);
      const safeAppErrorMessage = safeAppErrorMessageOrBlock(site, blockers);
      const siteDomains = [...(domainsBySite.get(site.id) ?? [])].sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
      if (siteDomains.length === 0) {
        blockers.push(blocker('SITE_WITHOUT_DOMAIN', 'Each legacy Site must have at least one SiteDomain', { siteId: site.id }));
        continue;
      }
      const primaryDomains = siteDomains.filter((domain) => domain.isPrimary);
      if (primaryDomains.length !== 1) {
        blockers.push(blocker('PRIMARY_DOMAIN_INVALID', 'Each legacy Site must have exactly one primary SiteDomain', { siteId: site.id, primaryCount: primaryDomains.length }));
        continue;
      }
      const primary = primaryDomains[0];
      if (primary.position !== 0 || siteDomains.some((domain, index) => domain.position !== index)) {
        blockers.push(blocker('DOMAIN_POSITION_INVALID', 'SiteDomain positions must be contiguous with the primary at zero', { siteId: site.id }));
      }
      const primaryPath = normalizedPathOrBlock(primary.filesRelPath ?? site.filesRelPath, site, primary.id, blockers);
      const primaryRuntimeKey = site.name;
      if (runtimeKeys.has(primaryRuntimeKey)) {
        blockers.push(blocker('RUNTIME_KEY_COLLISION', 'Derived runtime key collides with another SiteDomain', { siteId: site.id, domainId: primary.id }));
      } else runtimeKeys.set(primaryRuntimeKey, primary.id);
      const primaryDb = resolvePrimaryDatabase(site, primary, databasesBySite.get(site.id) ?? [], options.runtimeEvidence?.domains[primary.id]);
      if (primaryDb.ambiguity) {
        blockers.push(blocker('PRIMARY_DATABASE_AMBIGUOUS', 'Legacy primary database cannot be selected deterministically', { siteId: site.id, domainId: primary.id }));
      }
      if (isModxPreset(site.preset)) {
        if (site.phpVersion === null) blockers.push(blocker('MODX_PHP_MISSING', 'Managed MODX primary has no PHP version', { siteId: site.id, domainId: primary.id }));
        if (primaryDb.database === null) blockers.push(blocker('MODX_PRIMARY_DATABASE_UNRESOLVED', 'Managed MODX primary has no deterministically resolved MariaDB-compatible database', { siteId: site.id, domainId: primary.id }));
      }

      const phpEnabledByDomain = new Map<string, boolean>();
      for (const domain of siteDomains) {
        if (domain.id === primary.id) {
          phpEnabledByDomain.set(domain.id, site.phpVersion !== null);
          continue;
        }
        if (site.phpVersion === null) {
          phpEnabledByDomain.set(domain.id, false);
          continue;
        }
        const observed = options.runtimeEvidence?.domains[domain.id]?.phpEnabled;
        if (typeof observed !== 'boolean') {
          blockers.push(blocker(
            'SECONDARY_PHP_EVIDENCE_REQUIRED',
            'Secondary PHP capability must be observed from generated Nginx configuration, never inferred',
            { siteId: site.id, domainId: domain.id },
          ));
          phpEnabledByDomain.set(domain.id, false);
        } else {
          phpEnabledByDomain.set(domain.id, observed);
        }
      }

      const phpDomains = siteDomains.filter((domain) => phpEnabledByDomain.get(domain.id) === true);
      const poolAllocations = new Map<string, number>();
      if (phpDomains.length > 0) {
        const observedBudget = options.runtimeEvidence?.domains[primary.id]?.poolMaxChildren;
        if (!Number.isInteger(observedBudget)) {
          blockers.push(blocker(
            'PHP_POOL_BUDGET_EVIDENCE_REQUIRED',
            'Effective legacy pm.max_children must be observed before splitting the Site pool',
            { siteId: site.id, domainId: primary.id },
          ));
        } else if ((observedBudget as number) < phpDomains.length) {
          blockers.push(blocker(
            'PHP_POOL_BUDGET_TOO_SMALL',
            'Legacy PHP worker budget cannot provide at least one worker to every PHP-enabled SiteDomain',
            {
              siteId: site.id,
              legacyMaxChildren: observedBudget as number,
              requiredMinimum: phpDomains.length,
            },
          ));
        } else {
          const budget = observedBudget as number;
          const base = Math.floor(budget / phpDomains.length);
          const remainder = budget % phpDomains.length;
          for (const [index, domain] of phpDomains.entries()) {
            poolAllocations.set(domain.id, base + (index < remainder ? 1 : 0));
          }
          if (safePhpPoolCustom.configuredMaxChildren !== null
            && safePhpPoolCustom.configuredMaxChildren !== budget) {
            warnings.push(warning(
              'PHP_POOL_CONFIG_DRIFT',
              'Persisted PHP pool override differs from the effective generated pool; migration preserves the observed worker ceiling',
              { siteId: site.id },
            ));
          }
        }
      }

      if (primaryPath !== null) {
        addMapRow(rows, 'SITE', site.id, site.id, primary.id, null, {
          id: site.id,
          name: site.name,
          preset: site.preset,
          status: site.status,
          errorMessage: site.errorMessage,
          filesRelPath: site.filesRelPath,
          appPort: site.appPort,
          phpVersion: site.phpVersion,
          phpPoolCustom: site.phpPoolCustom,
        }, {
          primaryDomainId: primary.id,
          primaryRuntimeKey,
          primaryFilesRelPath: primaryPath,
          primaryPreset: site.preset,
          primaryAppStatus: appStatus,
          legacyPoolMaxChildren: options.runtimeEvidence?.domains[primary.id]?.poolMaxChildren ?? null,
          phpPoolCount: phpDomains.length,
        }, {
          primarySiteDomainId: primary.id,
          preset: null,
          appStatus: null,
          appErrorMessage: null,
          filesRelPath: null,
          phpVersion: null,
          phpPoolCustom: null,
          runtimeKey: null,
          appPort: null,
          purpose: null,
        });
      }

      for (const domain of siteDomains) {
        const isPrimary = domain.id === primary.id;
        const filesRelPath = normalizedPathOrBlock(domain.filesRelPath ?? site.filesRelPath, site, domain.id, blockers);
        const runtimeKey = isPrimary ? primaryRuntimeKey : deriveSecondaryRuntimeKey(domain.id);
        if (!isSafeRuntimeKey(runtimeKey)
          || (site.phpVersion !== null
            && !socketPathWithinLimit(runtimeKey, socketDirectory, socketMaxBytes, site.phpVersion))) {
          blockers.push(blocker('RUNTIME_KEY_INVALID', 'Derived runtime key is unsafe or exceeds the socket limit', { siteId: site.id, domainId: domain.id }));
        }
        const priorOwner = runtimeKeys.get(runtimeKey);
        if (priorOwner !== undefined && priorOwner !== domain.id) {
          blockers.push(blocker('RUNTIME_KEY_COLLISION', 'Derived runtime key collides with another SiteDomain', { siteId: site.id, domainId: domain.id }));
        } else runtimeKeys.set(runtimeKey, domain.id);

        const phpEnabled = phpEnabledByDomain.get(domain.id) === true;
        const poolMaxChildren = phpEnabled ? poolAllocations.get(domain.id) ?? 1 : null;
        if (filesRelPath !== null) {
          addMapRow(rows, 'DOMAIN', domain.id, site.id, domain.id, null, {
            id: domain.id,
            siteId: domain.siteId,
            domain: domain.domain,
            isPrimary: domain.isPrimary,
            position: domain.position,
            aliases: domain.aliases,
            filesRelPath: domain.filesRelPath,
            appPort: domain.appPort,
            sitePreset: site.preset,
            siteStatus: site.status,
            siteErrorMessage: site.errorMessage,
            sitePhpVersion: site.phpVersion,
            sitePhpPoolCustom: site.phpPoolCustom,
          }, {
            preset: isPrimary ? site.preset : 'CUSTOM',
            filesRelPath,
            runtimeKey,
            appStatus,
            phpEnabled,
            phpVersion: phpEnabled ? site.phpVersion : null,
            poolMaxChildren,
            appPort: isPrimary ? (domain.appPort ?? site.appPort) : domain.appPort,
            sharedRoot: !isPrimary && filesRelPath === primaryPath,
          }, {
            primarySiteDomainId: primary.id,
            preset: isPrimary ? site.preset : 'CUSTOM',
            appStatus,
            appErrorMessage: safeAppErrorMessage,
            filesRelPath,
            phpVersion: phpEnabled ? site.phpVersion : null,
            phpPoolCustom: phpEnabled
              ? poolCustomWithAllocation(safePhpPoolCustom.nonResource, poolMaxChildren ?? 1)
              : null,
            runtimeKey,
            appPort: isPrimary ? (domain.appPort ?? site.appPort) : domain.appPort,
            purpose: null,
          });
        }
      }

      for (const database of [...(databasesBySite.get(site.id) ?? [])].sort((left, right) => left.id.localeCompare(right.id))) {
        const selectedPrimary = primaryDb.database?.id === database.id;
        addMapRow(rows, 'DATABASE', database.id, site.id, primary.id, database.id, {
          id: database.id,
          siteId: database.siteId,
          name: database.name,
          type: database.type,
          dbUser: database.dbUser,
          siteDomainId: database.siteDomainId,
          purpose: database.purpose,
        }, {
          siteDomainId: primary.id,
          purpose: selectedPrimary ? 'APP_PRIMARY' : 'AUXILIARY',
          selectedBy: selectedPrimary ? 'ordered-primary-resolution' : 'legacy-site-ownership',
        }, {
          primarySiteDomainId: primary.id,
          preset: null,
          appStatus: null,
          appErrorMessage: null,
          filesRelPath: null,
          phpVersion: null,
          phpPoolCustom: null,
          runtimeKey: null,
          appPort: null,
          purpose: selectedPrimary ? 'APP_PRIMARY' : 'AUXILIARY',
        });
      }
    }
  }

  const secondFiles = await fingerprintDatabaseFiles(options.dbPath);
  if (!sameFileFingerprint(firstFiles.combined, secondFiles.combined)) {
    blockers.push(blocker('DATABASE_CHANGED_DURING_MAPPING', 'SQLite database changed while constructing a read-only migration map'));
  }
  const sortedRows = sortMapRows(rows);
  const sourceDbSha256 = sha256Json({
    sourceSchemaSha256: schema.sha256,
    source: logicalSource,
  });
  const envelopeBase = {
    version: 1 as const,
    targetMigration,
    sourceDbSha256,
    sourceFileSha256: firstFiles.combined,
    sourceSchemaSha256: schema.sha256,
    rows: sortedRows,
  };
  const envelope: MigrationMapEnvelope = {
    ...envelopeBase,
    mapSha256: mapHash(targetMigration, sourceDbSha256, schema.sha256, sortedRows),
  };
  return {
    ok: reportOk(blockers),
    envelope,
    blockers: redactDiagnostics(blockers),
    warnings: redactDiagnostics(warnings),
  };
}

function mapTableSql(table: string): string {
  return `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(table)} (
    "contract_version" INTEGER NOT NULL,
    "row_kind" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "site_domain_id" TEXT,
    "database_id" TEXT,
    "primary_site_domain_id" TEXT NOT NULL,
    "source_db_checksum" TEXT NOT NULL,
    "source_fingerprint" TEXT NOT NULL,
    "preset" TEXT,
    "app_status" TEXT,
    "app_error_message" TEXT,
    "files_rel_path" TEXT,
    "php_version" TEXT,
    "php_pool_custom" TEXT,
    "runtime_key" TEXT,
    "app_port" INTEGER,
    "purpose" TEXT,
    PRIMARY KEY ("row_kind", "source_id")
  );`;
}

/** Exact v1 staging-table shape consumed by z20260731000000. */
interface PersistedMapRow {
  readonly contract_version: number;
  readonly row_kind: MapRecordKind;
  readonly source_id: string;
  readonly site_id: string;
  readonly site_domain_id: string | null;
  readonly database_id: string | null;
  readonly primary_site_domain_id: string;
  readonly source_db_checksum: string;
  readonly source_fingerprint: string;
  readonly preset: string | null;
  readonly app_status: string | null;
  readonly app_error_message: string | null;
  readonly files_rel_path: string | null;
  readonly php_version: string | null;
  readonly php_pool_custom: string | null;
  readonly runtime_key: string | null;
  readonly app_port: number | null;
  readonly purpose: string | null;
}

interface MapTableColumnContract {
  readonly name: keyof PersistedMapRow;
  readonly type: 'INTEGER' | 'TEXT';
  readonly notNull: boolean;
  readonly primaryKeyPosition: number;
}

const MAP_TABLE_COLUMNS: readonly MapTableColumnContract[] = [
  { name: 'contract_version', type: 'INTEGER', notNull: true, primaryKeyPosition: 0 },
  { name: 'row_kind', type: 'TEXT', notNull: true, primaryKeyPosition: 1 },
  { name: 'source_id', type: 'TEXT', notNull: true, primaryKeyPosition: 2 },
  { name: 'site_id', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
  { name: 'site_domain_id', type: 'TEXT', notNull: false, primaryKeyPosition: 0 },
  { name: 'database_id', type: 'TEXT', notNull: false, primaryKeyPosition: 0 },
  { name: 'primary_site_domain_id', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
  { name: 'source_db_checksum', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
  { name: 'source_fingerprint', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
  { name: 'preset', type: 'TEXT', notNull: false, primaryKeyPosition: 0 },
  { name: 'app_status', type: 'TEXT', notNull: false, primaryKeyPosition: 0 },
  { name: 'app_error_message', type: 'TEXT', notNull: false, primaryKeyPosition: 0 },
  { name: 'files_rel_path', type: 'TEXT', notNull: false, primaryKeyPosition: 0 },
  { name: 'php_version', type: 'TEXT', notNull: false, primaryKeyPosition: 0 },
  { name: 'php_pool_custom', type: 'TEXT', notNull: false, primaryKeyPosition: 0 },
  { name: 'runtime_key', type: 'TEXT', notNull: false, primaryKeyPosition: 0 },
  { name: 'app_port', type: 'INTEGER', notNull: false, primaryKeyPosition: 0 },
  { name: 'purpose', type: 'TEXT', notNull: false, primaryKeyPosition: 0 },
] as const;

function expectedPersistedMapRow(envelope: MigrationMapEnvelope, row: MigrationMapRow): PersistedMapRow {
  const payload = stagingPayloadFor(row);
  return {
    contract_version: 1,
    row_kind: row.recordKind,
    source_id: row.sourceId,
    site_id: row.sourceSiteId,
    site_domain_id: row.sourceDomainId,
    database_id: row.sourceDatabaseId,
    primary_site_domain_id: payload.primarySiteDomainId,
    source_db_checksum: envelope.sourceDbSha256,
    source_fingerprint: envelope.sourceSchemaSha256,
    preset: payload.preset,
    app_status: payload.appStatus,
    app_error_message: payload.appErrorMessage,
    files_rel_path: payload.filesRelPath,
    php_version: payload.phpVersion,
    php_pool_custom: payload.phpPoolCustom,
    runtime_key: payload.runtimeKey,
    app_port: payload.appPort,
    purpose: payload.purpose,
  };
}

async function mapTableContractDiagnostics(dbPath: string, table: string): Promise<readonly Diagnostic[]> {
  const rows = await querySqliteJson(dbPath, `PRAGMA table_xinfo(${quoteIdentifier(table)});`);
  if (rows.length !== MAP_TABLE_COLUMNS.length) {
    return [blocker('MAP_TABLE_SCHEMA_INVALID', 'Existing map table has an unsupported number of columns', { expectedColumns: MAP_TABLE_COLUMNS.length, actualColumns: rows.length })];
  }
  const byName = new Map(rows.map((row) => [columnString(row, 'name'), row]));
  const diagnostics: Diagnostic[] = [];
  for (const expected of MAP_TABLE_COLUMNS) {
    const actual = byName.get(expected.name);
    if (actual === undefined) {
      diagnostics.push(blocker('MAP_TABLE_SCHEMA_INVALID', 'Existing map table is missing a required staging column', { column: expected.name }));
      continue;
    }
    const type = (columnString(actual, 'type') ?? '').toUpperCase();
    const notNull = columnNumber(actual, 'notnull') === 1;
    const primaryKeyPosition = columnNumber(actual, 'pk') ?? 0;
    if (type !== expected.type || notNull !== expected.notNull || primaryKeyPosition !== expected.primaryKeyPosition) {
      diagnostics.push(blocker('MAP_TABLE_SCHEMA_INVALID', 'Existing map table staging column does not match the v1 contract', { column: expected.name }));
    }
  }
  return diagnostics;
}

function persistedColumnEquals(actual: JsonObject, expected: PersistedMapRow): boolean {
  for (const column of MAP_TABLE_COLUMNS) {
    const expectedValue = expected[column.name];
    const actualValue = column.type === 'INTEGER'
      ? columnNumber(actual, column.name)
      : columnString(actual, column.name);
    if (actualValue !== expectedValue) return false;
  }
  return true;
}

async function mapTableDiagnostics(dbPath: string, table: string, envelope: MigrationMapEnvelope): Promise<readonly Diagnostic[]> {
  const tableInfo = await tableColumns(dbPath, table);
  if (!tableInfo.exists) return [];
  const contractDiagnostics = await mapTableContractDiagnostics(dbPath, table);
  if (contractDiagnostics.length > 0) return contractDiagnostics;
  const existingRows = await querySqliteJson(
    dbPath,
    `SELECT ${MAP_TABLE_COLUMNS.map((column) => quoteIdentifier(column.name)).join(', ')} FROM ${quoteIdentifier(table)} ORDER BY "row_kind", "source_id";`,
  );
  const expected = new Map<string, PersistedMapRow>(envelope.rows.map((row) => {
    const persisted = expectedPersistedMapRow(envelope, row);
    return [`${persisted.row_kind}:${persisted.source_id}`, persisted];
  }));
  const diagnostics: Diagnostic[] = [];
  for (const existing of existingRows) {
    const recordKind = columnString(existing, 'row_kind');
    const sourceId = columnString(existing, 'source_id');
    if (recordKind === null || sourceId === null) {
      diagnostics.push(blocker('MAP_TABLE_ROW_INVALID', 'Existing map table contains an invalid row'));
      continue;
    }
    const key = `${recordKind}:${sourceId}`;
    const mapped = expected.get(key);
    if (mapped === undefined) {
      diagnostics.push(blocker('MAP_TABLE_STALE_ROW', 'Existing map table contains a stale row for this target migration', { recordKind, sourceId }));
      continue;
    }
    if (!persistedColumnEquals(existing, mapped)) {
      diagnostics.push(blocker('MAP_TABLE_ROW_STALE', 'Existing map row differs from the newly validated source map', { recordKind, sourceId }));
    }
  }
  if (existingRows.length !== expected.size) {
    diagnostics.push(blocker('MAP_TABLE_INCOMPLETE', 'Existing map table has only a partial row set for this target migration'));
  }
  return diagnostics;
}

function mapInsertSql(table: string, envelope: MigrationMapEnvelope, row: MigrationMapRow): string {
  const persisted = expectedPersistedMapRow(envelope, row);
  const columns = MAP_TABLE_COLUMNS.map((column) => quoteIdentifier(column.name)).join(', ');
  const values = MAP_TABLE_COLUMNS.map((column) => quoteLiteral(persisted[column.name])).join(', ');
  return `INSERT INTO ${quoteIdentifier(table)} (${columns}) VALUES (${values});`;
}

/**
 * Persist an already validated map only when every prior row is identical.
 * This intentionally does not delete or replace rows: stale maps are blockers.
 */
export async function applyLegacyMigrationMap(options: ApplyLegacyMapOptions): Promise<ApplyLegacyMapResult> {
  const report = await buildLegacyMigrationMap(options);
  if (!report.ok) return { report, changed: false };
  if (options.writeMode !== 'clone' && options.writeMode !== 'live') {
    throw new Error('Explicit writeMode must be clone or live before persisting a migration map');
  }
  const table = mapTableName(options.mapTable);
  const currentFiles = await fingerprintDatabaseFiles(options.dbPath);
  if (currentFiles.combined !== report.envelope.sourceFileSha256) {
    return {
      report: {
        ...report,
        ok: false,
        blockers: [...report.blockers, blocker('DATABASE_CHANGED_BEFORE_MAP_APPLY', 'SQLite database changed after map validation and before map insertion')],
      },
      changed: false,
    };
  }
  const tableDiagnostics = await mapTableDiagnostics(options.dbPath, table, report.envelope);
  if (tableDiagnostics.length > 0) {
    return { report: { ...report, ok: false, blockers: [...report.blockers, ...redactDiagnostics(tableDiagnostics)] }, changed: false };
  }
  const existing = await tableColumns(options.dbPath, table);
  if (!existing.exists && report.envelope.rows.length === 0) return { report, changed: false };
  const existingRows = existing.exists
    ? await querySqliteJson(options.dbPath, `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)};`)
    : [];
  const existingCount = existingRows.length === 0 ? 0 : columnNumber(existingRows[0], 'count') ?? 0;
  if (existingCount === report.envelope.rows.length) return { report, changed: false };
  const script = [
    'PRAGMA foreign_keys = ON;',
    'BEGIN IMMEDIATE;',
    mapTableSql(table),
    ...report.envelope.rows.map((row) => mapInsertSql(table, report.envelope, row)),
    'COMMIT;',
  ].join('\n');
  await runSqliteScript(options.dbPath, script);
  return { report, changed: report.envelope.rows.length > 0 };
}

export function legacyMapReportJson(report: LegacyMapReport): JsonObject {
  return {
    ok: report.ok,
    envelope: {
      version: report.envelope.version,
      targetMigration: report.envelope.targetMigration,
      sourceDbSha256: report.envelope.sourceDbSha256,
      sourceFileSha256: report.envelope.sourceFileSha256,
      sourceSchemaSha256: report.envelope.sourceSchemaSha256,
      mapSha256: report.envelope.mapSha256,
      rows: report.envelope.rows.map((row) => ({
        recordKind: row.recordKind,
        sourceId: row.sourceId,
        sourceSiteId: row.sourceSiteId,
        sourceDomainId: row.sourceDomainId,
        sourceDatabaseId: row.sourceDatabaseId,
        rowSha256: row.rowSha256,
        payload: row.payload,
      })),
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

/** Parse optional evidence without accepting arbitrary configuration blobs. */
export function parseRuntimeEvidence(value: unknown): RuntimeEvidence {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('runtime evidence must be a JSON object');
  const domainsValue = (value as Record<string, unknown>).domains;
  if (domainsValue === null || typeof domainsValue !== 'object' || Array.isArray(domainsValue)) {
    throw new Error('runtime evidence.domains must be a JSON object');
  }
  const domains: Record<string, RuntimeEvidenceEntry> = {};
  for (const [domainId, entry] of Object.entries(domainsValue as Record<string, unknown>)) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('runtime evidence domain entry must be an object');
    const candidate = entry as Record<string, unknown>;
    const phpEnabled = candidate.phpEnabled;
    const modxDatabaseName = candidate.modxDatabaseName;
    const poolMaxChildren = candidate.poolMaxChildren;
    if (phpEnabled !== undefined && typeof phpEnabled !== 'boolean') throw new Error('runtime evidence phpEnabled must be boolean');
    if (modxDatabaseName !== undefined && typeof modxDatabaseName !== 'string') throw new Error('runtime evidence modxDatabaseName must be text');
    if (poolMaxChildren !== undefined
      && (!Number.isInteger(poolMaxChildren) || (poolMaxChildren as number) < 1 || (poolMaxChildren as number) > 1024)) {
      throw new Error('runtime evidence poolMaxChildren must be an integer from 1 to 1024');
    }
    domains[domainId] = {
      ...(phpEnabled === undefined ? {} : { phpEnabled }),
      ...(modxDatabaseName === undefined ? {} : { modxDatabaseName }),
      ...(poolMaxChildren === undefined ? {} : { poolMaxChildren: poolMaxChildren as number }),
    };
  }
  return { domains };
}

export async function loadRuntimeEvidence(evidencePath: string): Promise<RuntimeEvidence> {
  return parseRuntimeEvidence(JSON.parse(await readFile(evidencePath, 'utf8')));
}
