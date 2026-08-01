import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  fingerprintDatabase,
  fingerprintDigest,
  sameFingerprint,
  type SchemaFingerprint,
} from './fingerprint';
import { redactDiagnostics } from './redaction';
import { querySqliteJson, quoteIdentifier, quoteLiteral } from './sqlite';
import { blocker, reportOk, warning, type DatabaseWriteMode, type Diagnostic, type JsonObject, type JsonValue } from './types';

const PRISMA_TABLE = '_prisma_migrations';
// This release's table-copy migration is the boundary after which a valid
// candidate Prisma history is authoritative and no legacy mapper may run.
const DOMAIN_APPLICATIONS_MIGRATION = 'z20260731000000_domain_centric_applications';
const REQUIRED_PRISMA_COLUMNS = [
  'id',
  'checksum',
  'finished_at',
  'migration_name',
  'logs',
  'rolled_back_at',
  'started_at',
  'applied_steps_count',
] as const;

export interface PrismaMigrationSpec {
  readonly name: string;
  readonly checksum: string;
  /** Prisma's historical default is zero; it does not mean a failed migration. */
  readonly appliedStepsCount?: number;
}

export interface SupportedSchemaVariant {
  readonly id: string;
  /**
   * Optional embedded structural manifest. A SHA-256 of the canonical manifest
   * is still an exact allowlist when releases keep the large manifest in their
   * approved fixture archive rather than duplicating it in every artifact.
   */
  readonly fingerprint?: SchemaFingerprint;
  /** SHA-256 of the exact table/column/index fingerprint. */
  readonly sha256: string;
}

export interface SupportedBaseline {
  readonly id: string;
  /** Named, exact schema variants that share one approved migration lineage. */
  readonly schemaVariants: readonly SupportedSchemaVariant[];
  /** Every historical migration that must be recorded before migrate deploy. */
  readonly prismaMigrations: readonly PrismaMigrationSpec[];
}

export interface BaselineContract {
  readonly version: 2;
  readonly supportedBaselines: readonly SupportedBaseline[];
}

export type PrismaHistoryState = 'absent' | 'empty' | 'valid' | 'partial';

export interface PrismaHistoryEntry {
  readonly migrationName: string;
  readonly checksum: string;
  readonly appliedStepsCount: number;
}

export interface PrismaHistoryInspection {
  readonly state: PrismaHistoryState;
  readonly entries: readonly PrismaHistoryEntry[];
  readonly diagnostics: readonly Diagnostic[];
}

export type BaselineDecision = 'blocked' | 'fresh' | 'baseline-required' | 'already-tracked';

export interface BaselineAssessment {
  readonly ok: boolean;
  readonly decision: BaselineDecision;
  readonly schemaSha256: string;
  readonly supportedBaselineId: string | null;
  /** True only for the exact pre-domain schema that needs the one-shot map. */
  readonly legacyMappingRequired: boolean;
  readonly history: PrismaHistoryInspection;
  readonly blockers: readonly Diagnostic[];
  readonly warnings: readonly Diagnostic[];
}

export interface AssessBaselineOptions {
  readonly dbPath: string;
  readonly apiDir: string;
  readonly contract: BaselineContract;
}

export interface ApplyBaselineOptions extends AssessBaselineOptions {
  /** Explicitly supplied by the caller; no implicit live write is possible. */
  readonly writeMode: DatabaseWriteMode;
}

export interface ApplyBaselineResult {
  readonly assessment: BaselineAssessment;
  readonly changed: boolean;
}

class ContractError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ContractError';
  }
}

const execFileP = promisify(execFile);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function expectString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new ContractError(`${context} must be a non-empty string`);
  return value;
}

function expectNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ContractError(`${context} must be a finite number`);
  return value;
}

function expectBoolean(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') throw new ContractError(`${context} must be boolean`);
  return value;
}

function expectArray(value: unknown, context: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new ContractError(`${context} must be an array`);
  return value;
}

function expectNullableString(value: unknown, context: string): string | null {
  if (value === null) return null;
  return expectString(value, context);
}

function parseColumn(value: unknown, context: string): SchemaFingerprint['tables'][number]['columns'][number] {
  if (!isRecord(value)) throw new ContractError(`${context} must be an object`);
  return {
    cid: expectNumber(value.cid, `${context}.cid`),
    name: expectString(value.name, `${context}.name`),
    type: typeof value.type === 'string' ? value.type : (() => { throw new ContractError(`${context}.type must be a string`); })(),
    notNull: expectBoolean(value.notNull, `${context}.notNull`),
    defaultValue: expectNullableString(value.defaultValue, `${context}.defaultValue`),
    primaryKeyPosition: expectNumber(value.primaryKeyPosition, `${context}.primaryKeyPosition`),
    hidden: expectNumber(value.hidden, `${context}.hidden`),
  };
}

function parseForeignKey(value: unknown, context: string): SchemaFingerprint['tables'][number]['foreignKeys'][number] {
  if (!isRecord(value)) throw new ContractError(`${context} must be an object`);
  return {
    id: expectNumber(value.id, `${context}.id`),
    sequence: expectNumber(value.sequence, `${context}.sequence`),
    table: expectString(value.table, `${context}.table`),
    from: expectString(value.from, `${context}.from`),
    to: expectNullableString(value.to, `${context}.to`),
    onUpdate: expectString(value.onUpdate, `${context}.onUpdate`),
    onDelete: expectString(value.onDelete, `${context}.onDelete`),
    match: expectString(value.match, `${context}.match`),
  };
}

function parseIndexColumn(value: unknown, context: string): SchemaFingerprint['tables'][number]['indexes'][number]['columns'][number] {
  if (!isRecord(value)) throw new ContractError(`${context} must be an object`);
  return {
    sequence: expectNumber(value.sequence, `${context}.sequence`),
    columnId: expectNumber(value.columnId, `${context}.columnId`),
    name: expectNullableString(value.name, `${context}.name`),
    descending: expectBoolean(value.descending, `${context}.descending`),
    collation: expectString(value.collation, `${context}.collation`),
    key: expectBoolean(value.key, `${context}.key`),
  };
}

function parseIndex(value: unknown, context: string): SchemaFingerprint['tables'][number]['indexes'][number] {
  if (!isRecord(value)) throw new ContractError(`${context} must be an object`);
  return {
    name: expectString(value.name, `${context}.name`),
    unique: expectBoolean(value.unique, `${context}.unique`),
    origin: expectString(value.origin, `${context}.origin`),
    partial: expectBoolean(value.partial, `${context}.partial`),
    sql: expectNullableString(value.sql, `${context}.sql`),
    columns: expectArray(value.columns, `${context}.columns`).map((item, index) => parseIndexColumn(item, `${context}.columns[${index}]`)),
  };
}

function parseTable(value: unknown, context: string): SchemaFingerprint['tables'][number] {
  if (!isRecord(value)) throw new ContractError(`${context} must be an object`);
  return {
    name: expectString(value.name, `${context}.name`),
    sql: expectNullableString(value.sql, `${context}.sql`),
    columns: expectArray(value.columns, `${context}.columns`).map((item, index) => parseColumn(item, `${context}.columns[${index}]`)),
    foreignKeys: expectArray(value.foreignKeys, `${context}.foreignKeys`).map((item, index) => parseForeignKey(item, `${context}.foreignKeys[${index}]`)),
    indexes: expectArray(value.indexes, `${context}.indexes`).map((item, index) => parseIndex(item, `${context}.indexes[${index}]`)),
  };
}

function parseSchemaObject(value: unknown, context: string): SchemaFingerprint['views'][number] {
  if (!isRecord(value)) throw new ContractError(`${context} must be an object`);
  return {
    name: expectString(value.name, `${context}.name`),
    sql: expectNullableString(value.sql, `${context}.sql`),
  };
}

function parseFingerprint(value: unknown, context: string): SchemaFingerprint {
  if (!isRecord(value)) throw new ContractError(`${context} must be an object`);
  if (value.format !== 'meowbox.sqlite-schema.v1') throw new ContractError(`${context}.format is unsupported`);
  return {
    format: 'meowbox.sqlite-schema.v1',
    applicationId: expectNumber(value.applicationId, `${context}.applicationId`),
    userVersion: expectNumber(value.userVersion, `${context}.userVersion`),
    tables: expectArray(value.tables, `${context}.tables`).map((item, index) => parseTable(item, `${context}.tables[${index}]`)),
    views: expectArray(value.views, `${context}.views`).map((item, index) => parseSchemaObject(item, `${context}.views[${index}]`)),
    triggers: expectArray(value.triggers, `${context}.triggers`).map((item, index) => parseSchemaObject(item, `${context}.triggers[${index}]`)),
  };
}

function parseMigrationSpec(value: unknown, context: string): PrismaMigrationSpec {
  if (!isRecord(value)) throw new ContractError(`${context} must be an object`);
  const name = expectString(value.name, `${context}.name`);
  const checksum = expectString(value.checksum, `${context}.checksum`);
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new ContractError(`${context}.name contains unsupported characters`);
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw new ContractError(`${context}.checksum must be lowercase SHA-256`);
  const appliedStepsCount = value.appliedStepsCount === undefined
    ? undefined
    : expectNumber(value.appliedStepsCount, `${context}.appliedStepsCount`);
  if (appliedStepsCount !== undefined && (!Number.isInteger(appliedStepsCount) || appliedStepsCount < 0)) {
    throw new ContractError(`${context}.appliedStepsCount must be a non-negative integer`);
  }
  return appliedStepsCount === undefined ? { name, checksum } : { name, checksum, appliedStepsCount };
}

function parseSchemaVariant(value: unknown, context: string): SupportedSchemaVariant {
  if (!isRecord(value)) throw new ContractError(`${context} must be an object`);
  const fingerprint = value.fingerprint === undefined ? undefined : parseFingerprint(value.fingerprint, `${context}.fingerprint`);
  const sha256 = expectString(value.sha256, `${context}.sha256`);
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new ContractError(`${context}.sha256 must be lowercase SHA-256`);
  if (fingerprint !== undefined && fingerprintDigest(fingerprint) !== sha256) {
    throw new ContractError(`${context}.sha256 does not match the supplied fingerprint`);
  }
  return {
    id: expectString(value.id, `${context}.id`),
    fingerprint,
    sha256,
  };
}

function parseSupportedBaseline(value: unknown, context: string): SupportedBaseline {
  if (!isRecord(value)) throw new ContractError(`${context} must be an object`);
  const schemaVariants = expectArray(value.schemaVariants, `${context}.schemaVariants`)
    .map((item, index) => parseSchemaVariant(item, `${context}.schemaVariants[${index}]`));
  if (schemaVariants.length === 0) throw new ContractError(`${context}.schemaVariants must not be empty`);
  const variantIds = new Set<string>();
  const variantDigests = new Set<string>();
  for (const variant of schemaVariants) {
    if (variantIds.has(variant.id)) throw new ContractError(`${context}.schemaVariants contains duplicate id ${variant.id}`);
    if (variantDigests.has(variant.sha256)) throw new ContractError(`${context}.schemaVariants contains duplicate SHA-256 ${variant.sha256}`);
    variantIds.add(variant.id);
    variantDigests.add(variant.sha256);
  }
  const prismaMigrations = expectArray(value.prismaMigrations, `${context}.prismaMigrations`)
    .map((item, index) => parseMigrationSpec(item, `${context}.prismaMigrations[${index}]`));
  const names = new Set<string>();
  for (const migration of prismaMigrations) {
    if (names.has(migration.name)) throw new ContractError(`${context}.prismaMigrations contains duplicate ${migration.name}`);
    names.add(migration.name);
  }
  return {
    id: expectString(value.id, `${context}.id`),
    schemaVariants,
    prismaMigrations,
  };
}

function assertUniqueBaselines(supportedBaselines: readonly SupportedBaseline[]): void {
  const ids = new Set<string>();
  const fingerprints = new Map<string, string>();
  for (const baseline of supportedBaselines) {
    if (ids.has(baseline.id)) throw new ContractError(`Baseline contract contains duplicate id ${baseline.id}`);
    ids.add(baseline.id);
    for (const variant of baseline.schemaVariants) {
      const digest = variant.sha256;
      const owner = fingerprints.get(digest);
      if (owner !== undefined) {
        throw new ContractError(`Baseline fingerprint ${digest} is assigned to both ${owner} and ${baseline.id}`);
      }
      fingerprints.set(digest, baseline.id);
    }
  }
}

/** Load a fail-closed schema allowlist. An empty list is a valid placeholder. */
export async function loadBaselineContract(contractPath: string): Promise<BaselineContract> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(contractPath, 'utf8'));
  } catch (error) {
    throw new ContractError(`Could not read baseline contract: ${(error as Error).message}`);
  }
  if (!isRecord(parsed)) throw new ContractError('Baseline contract must be a JSON object');
  if (parsed.version !== 2) throw new ContractError('Baseline contract version must be 2');
  const supportedBaselines = expectArray(parsed.supportedBaselines, 'supportedBaselines')
    .map((item, index) => parseSupportedBaseline(item, `supportedBaselines[${index}]`));
  assertUniqueBaselines(supportedBaselines);
  return { version: 2, supportedBaselines };
}

async function prismaTableExists(dbPath: string): Promise<boolean> {
  const rows = await querySqliteJson(
    dbPath,
    `SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = ${quoteLiteral(PRISMA_TABLE)} LIMIT 1;`,
  );
  return rows.length === 1;
}

function scalarIsMissing(value: JsonValue | undefined): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * A failed, rolled-back or half-recorded Prisma migration is never repaired by
 * this tool. It is a hard preflight blocker because appending history can hide
 * a schema/data mismatch from `prisma migrate deploy`.
 */
export async function inspectPrismaHistory(dbPath: string): Promise<PrismaHistoryInspection> {
  if (!(await prismaTableExists(dbPath))) return { state: 'absent', entries: [], diagnostics: [] };
  const columns = await querySqliteJson(dbPath, `PRAGMA table_xinfo(${quoteIdentifier(PRISMA_TABLE)});`);
  const names = new Set(columns.map((column) => column.name).filter((name): name is string => typeof name === 'string'));
  const missing = REQUIRED_PRISMA_COLUMNS.filter((column) => !names.has(column));
  if (missing.length > 0) {
    return {
      state: 'partial',
      entries: [],
      diagnostics: [blocker('PRISMA_HISTORY_SCHEMA_INVALID', 'Prisma history table has an unsupported shape', { missingColumns: [...missing] })],
    };
  }
  const rows = await querySqliteJson(
    dbPath,
    `SELECT id, checksum, finished_at, migration_name, rolled_back_at, started_at, applied_steps_count FROM ${quoteIdentifier(PRISMA_TABLE)} ORDER BY started_at, migration_name, id;`,
  );
  if (rows.length === 0) return { state: 'empty', entries: [], diagnostics: [] };

  const diagnostics: Diagnostic[] = [];
  const entries: PrismaHistoryEntry[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row.migration_name;
    const checksum = row.checksum;
    const steps = row.applied_steps_count;
    const safeName = typeof name === 'string' ? name : '<invalid>';
    if (typeof name !== 'string' || name.length === 0 || typeof checksum !== 'string' || !/^[a-f0-9]{64}$/.test(checksum)) {
      diagnostics.push(blocker('PRISMA_HISTORY_ROW_INVALID', 'Prisma history contains an invalid migration record', { migrationName: safeName }));
      continue;
    }
    if (scalarIsMissing(row.finished_at) || row.rolled_back_at !== null || scalarIsMissing(row.started_at)) {
      diagnostics.push(blocker('PRISMA_HISTORY_PARTIAL', 'Prisma history contains a failed, rolled-back, or unfinished migration', { migrationName: name }));
    }
    if (typeof steps !== 'number' || !Number.isInteger(steps) || steps < 0) {
      diagnostics.push(blocker('PRISMA_HISTORY_ROW_INVALID', 'Prisma history contains an invalid step count', { migrationName: name }));
    }
    if (seen.has(name)) {
      diagnostics.push(blocker('PRISMA_HISTORY_DUPLICATE', 'Prisma history contains a duplicate migration name', { migrationName: name }));
    }
    seen.add(name);
    if (typeof steps === 'number' && Number.isInteger(steps) && steps >= 0) {
      entries.push({ migrationName: name, checksum, appliedStepsCount: steps });
    }
  }
  return {
    state: diagnostics.some((item) => item.severity === 'blocker') ? 'partial' : 'valid',
    entries,
    diagnostics,
  };
}

async function migrationDirectory(apiDir: string): Promise<string> {
  const candidates = [path.join(apiDir, 'prisma', 'migrations'), path.join(apiDir, 'migrations')];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isDirectory()) return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new Error('api-dir does not contain prisma/migrations or migrations');
}

async function verifyMigrationArtifacts(apiDir: string, expected: readonly PrismaMigrationSpec[]): Promise<readonly Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  let root: string;
  try {
    root = await migrationDirectory(apiDir);
  } catch {
    return [blocker('PRISMA_ARTIFACTS_MISSING', 'Candidate API directory does not contain Prisma migration artifacts')];
  }
  for (const migration of expected) {
    const scriptPath = path.join(root, migration.name, 'migration.sql');
    let content: Buffer;
    try {
      content = await readFile(scriptPath);
    } catch {
      diagnostics.push(blocker('PRISMA_ARTIFACT_MISSING', 'A required historical Prisma migration artifact is missing', { migrationName: migration.name }));
      continue;
    }
    const actual = createHash('sha256').update(content).digest('hex');
    if (actual !== migration.checksum) {
      diagnostics.push(blocker('PRISMA_ARTIFACT_CHECKSUM_MISMATCH', 'A required historical Prisma migration artifact differs from the approved contract', { migrationName: migration.name }));
    }
  }
  return diagnostics;
}

interface CandidateMigrationInventory {
  readonly migrations: readonly PrismaMigrationSpec[];
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Existing Prisma history is trusted only when every recorded item exists
 * byte-for-byte in the candidate's own migration inventory.
 * This is deliberately separate from legacy baselining: it never writes or
 * tries to derive a structural fingerprint for a later, already-tracked
 * release.
 */
async function inspectCandidateMigrationInventory(apiDir: string): Promise<CandidateMigrationInventory> {
  let root: string;
  try {
    root = await migrationDirectory(apiDir);
  } catch {
    return {
      migrations: [],
      diagnostics: [blocker('PRISMA_ARTIFACTS_MISSING', 'Candidate API directory does not contain Prisma migration artifacts')],
    };
  }
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return {
      migrations: [],
      diagnostics: [blocker('PRISMA_ARTIFACTS_UNREADABLE', 'Candidate Prisma migration artifacts cannot be read')],
    };
  }
  const diagnostics: Diagnostic[] = [];
  const migrations: PrismaMigrationSpec[] = [];
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    // Prisma migration directory ordering is byte/lexical, not locale-aware.
    .sort();
  for (const name of directories) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
      diagnostics.push(blocker('PRISMA_ARTIFACT_NAME_INVALID', 'Candidate Prisma migration directory has an unsupported name', { migrationName: name }));
      continue;
    }
    const scriptPath = path.join(root, name, 'migration.sql');
    let content: Buffer;
    try {
      content = await readFile(scriptPath);
    } catch {
      diagnostics.push(blocker('PRISMA_ARTIFACT_MISSING', 'Candidate Prisma migration directory is missing migration.sql', { migrationName: name }));
      continue;
    }
    migrations.push({ name, checksum: createHash('sha256').update(content).digest('hex') });
  }
  if (migrations.length === 0) {
    diagnostics.push(blocker('PRISMA_ARTIFACTS_MISSING', 'Candidate API directory contains no Prisma migration SQL artifacts'));
  }
  return { migrations, diagnostics };
}

function compareHistoryToCandidateInventory(
  history: PrismaHistoryInspection,
  candidate: readonly PrismaMigrationSpec[],
): readonly Diagnostic[] {
  if (history.state !== 'valid') return [];
  const diagnostics: Diagnostic[] = [];
  const inventory = new Map(candidate.map((migration) => [migration.name, migration]));
  for (const recorded of history.entries) {
    const expected = inventory.get(recorded.migrationName);
    if (expected === undefined) {
      diagnostics.push(blocker('PRISMA_HISTORY_UNEXPECTED', 'Prisma history contains a migration absent from the candidate migration tree', { migrationName: recorded.migrationName }));
      continue;
    }
    if (expected.checksum !== recorded.checksum) {
      diagnostics.push(blocker('PRISMA_HISTORY_CHECKSUM_MISMATCH', 'Prisma history checksum does not match the candidate migration artifact', { migrationName: recorded.migrationName }));
    }
  }
  return diagnostics;
}

function compareHistoryToBaseline(history: PrismaHistoryInspection, baseline: SupportedBaseline): readonly Diagnostic[] {
  if (history.state !== 'valid') return [];
  const actual = new Map(history.entries.map((entry) => [entry.migrationName, entry]));
  const expected = new Map(baseline.prismaMigrations.map((entry) => [entry.name, entry]));
  const diagnostics: Diagnostic[] = [];
  for (const [name, migration] of expected) {
    const recorded = actual.get(name);
    if (recorded === undefined) {
      diagnostics.push(blocker('PRISMA_HISTORY_INCOMPLETE', 'Prisma history is valid-looking but does not cover this exact schema', { migrationName: name }));
    } else if (recorded.checksum !== migration.checksum) {
      diagnostics.push(blocker('PRISMA_HISTORY_CHECKSUM_MISMATCH', 'Prisma history checksum does not match the approved migration artifact', { migrationName: name }));
    }
  }
  for (const name of actual.keys()) {
    if (!expected.has(name)) {
      diagnostics.push(blocker('PRISMA_HISTORY_UNEXPECTED', 'Prisma history contains a migration outside the approved legacy baseline', { migrationName: name }));
    }
  }
  return diagnostics;
}

function historyIncludesBaseline(
  history: PrismaHistoryInspection,
  baseline: SupportedBaseline,
): boolean {
  if (history.state !== 'valid') return false;
  const actual = new Map(history.entries.map((entry) => [entry.migrationName, entry]));
  return baseline.prismaMigrations.every((migration) =>
    actual.get(migration.name)?.checksum === migration.checksum,
  );
}

function matchesBaselineFingerprint(
  baseline: SupportedBaseline,
  sha256: string,
  schema: SchemaFingerprint,
): boolean {
  return baseline.schemaVariants.some((variant) =>
    variant.sha256 === sha256
      && (variant.fingerprint === undefined || sameFingerprint(variant.fingerprint, schema)),
  );
}

/** Decide whether a supported untracked DB needs a history baseline. No write. */
export async function assessBaseline(options: AssessBaselineOptions): Promise<BaselineAssessment> {
  const [fingerprint, history] = await Promise.all([
    fingerprintDatabase(options.dbPath),
    inspectPrismaHistory(options.dbPath),
  ]);
  const blockers: Diagnostic[] = [...history.diagnostics];
  const warnings: Diagnostic[] = [];
  const isFresh = fingerprint.schema.tables.length === 0
    && fingerprint.schema.views.length === 0
    && fingerprint.schema.triggers.length === 0
    && (history.state === 'absent' || history.state === 'empty');
  if (isFresh) {
    return {
      ok: true,
      decision: 'fresh',
      schemaSha256: fingerprint.sha256,
      supportedBaselineId: null,
      legacyMappingRequired: false,
      history,
      blockers: [],
      warnings: [warning('FRESH_DATABASE', 'SQLite database has no application schema; Prisma migrate deploy may initialize it')],
    };
  }
  const matched = options.contract.supportedBaselines.find((candidate) =>
    matchesBaselineFingerprint(candidate, fingerprint.sha256, fingerprint.schema),
  );
  if (matched !== undefined) {
    const artifactDiagnostics = await verifyMigrationArtifacts(options.apiDir, matched.prismaMigrations);
    blockers.push(...artifactDiagnostics);
    if (history.state === 'partial') {
      return {
        ok: false,
        decision: 'blocked',
        schemaSha256: fingerprint.sha256,
        supportedBaselineId: matched.id,
        legacyMappingRequired: true,
        history,
        blockers: redactDiagnostics(blockers),
        warnings: redactDiagnostics(warnings),
      };
    }
    if (history.state === 'valid') blockers.push(...compareHistoryToBaseline(history, matched));
    const decision: BaselineDecision = history.state === 'absent' || history.state === 'empty'
      ? 'baseline-required'
      : blockers.length === 0 ? 'already-tracked' : 'blocked';
    if (decision === 'baseline-required') {
      warnings.push(warning('PRISMA_BASELINE_REQUIRED', 'Approved legacy schema has no Prisma migration history and must be baselined before deploy', { baselineId: matched.id }));
    }
    return {
      ok: reportOk(blockers),
      decision: blockers.length > 0 ? 'blocked' : decision,
      schemaSha256: fingerprint.sha256,
      supportedBaselineId: matched.id,
      legacyMappingRequired: true,
      history,
      blockers: redactDiagnostics(blockers),
      warnings: redactDiagnostics(warnings),
    };
  }

  // A DB that already carries the domain table-copy migration has no stable
  // legacy fingerprint by design: later releases add their own schema. Trust
  // it only when its completed history is an exact checksum-verified prefix
  // of this candidate, and never run the legacy mapper against it again.
  if (history.state === 'valid') {
    const inventory = await inspectCandidateMigrationInventory(options.apiDir);
    blockers.push(...inventory.diagnostics, ...compareHistoryToCandidateInventory(history, inventory.migrations));
    const candidateHasDomainMigration = inventory.migrations.some((migration) => migration.name === DOMAIN_APPLICATIONS_MIGRATION);
    const historyHasDomainMigration = history.entries.some((entry) => entry.migrationName === DOMAIN_APPLICATIONS_MIGRATION);
    const historyIncludesApprovedLegacyBaseline = options.contract.supportedBaselines.some((baseline) =>
      historyIncludesBaseline(history, baseline),
    );
    if (!candidateHasDomainMigration) {
      blockers.push(blocker('PRISMA_CANDIDATE_DOMAIN_MIGRATION_MISSING', 'Candidate migration tree does not retain the domain applications migration artifact'));
    }
    if (!historyHasDomainMigration) {
      blockers.push(blocker(
        'UNSUPPORTED_SCHEMA_FINGERPRINT',
        'SQLite schema is not an exact supported legacy baseline and Prisma history has not crossed the domain migration boundary',
        { schemaSha256: fingerprint.sha256 },
      ));
    }
    if (!historyIncludesApprovedLegacyBaseline) {
      blockers.push(blocker(
        'PRISMA_HISTORY_LEGACY_BASELINE_MISSING',
        'Prisma history does not contain a complete approved legacy migration set',
      ));
    }
    if (blockers.length === 0) {
      warnings.push(warning('PRISMA_HISTORY_TRUSTED', 'Completed Prisma history is an exact candidate prefix after the domain migration; legacy baseline and mapper are skipped'));
      return {
        ok: true,
        decision: 'already-tracked',
        schemaSha256: fingerprint.sha256,
        supportedBaselineId: null,
        legacyMappingRequired: false,
        history,
        blockers: [],
        warnings: redactDiagnostics(warnings),
      };
    }
  }

  blockers.push(blocker(
    'UNSUPPORTED_SCHEMA_FINGERPRINT',
    'SQLite schema does not exactly match an explicitly supported legacy baseline',
    { schemaSha256: fingerprint.sha256 },
  ));
  return {
    ok: false,
    decision: 'blocked',
    schemaSha256: fingerprint.sha256,
    supportedBaselineId: null,
    legacyMappingRequired: false,
    history,
    blockers: redactDiagnostics(blockers),
    warnings: redactDiagnostics(warnings),
  };
}

async function prismaSchemaPath(apiDir: string): Promise<string> {
  const candidates = [path.join(apiDir, 'prisma', 'schema.prisma'), path.join(apiDir, 'schema.prisma')];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new Error('Candidate API directory does not contain prisma/schema.prisma');
}

async function prismaExecutable(apiDir: string): Promise<string> {
  const candidate = path.join(apiDir, 'node_modules', '.bin', process.platform === 'win32' ? 'prisma.cmd' : 'prisma');
  try {
    if ((await stat(candidate)).isFile()) return candidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  throw new Error('Candidate API directory has no local Prisma CLI');
}

async function markMigrationApplied(
  apiDir: string,
  dbPath: string,
  schemaPath: string,
  migrationName: string,
): Promise<void> {
  const executable = await prismaExecutable(apiDir);
  try {
    await execFileP(
      executable,
      ['migrate', 'resolve', '--schema', schemaPath, '--applied', migrationName],
      {
        cwd: apiDir,
        env: { ...process.env, DATABASE_URL: pathToFileURL(path.resolve(dbPath)).href },
        maxBuffer: 1024 * 1024,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 800) : 'unknown Prisma CLI failure';
    throw new Error(`Prisma migrate resolve failed for ${migrationName}: ${message}`);
  }
}

/**
 * Insert approved historical migration records. The caller must explicitly
 * state clone or live mode; this function never receives a default mode.
 */
export async function applyBaseline(options: ApplyBaselineOptions): Promise<ApplyBaselineResult> {
  const assessment = await assessBaseline(options);
  if (!assessment.ok) return { assessment, changed: false };
  if (assessment.decision === 'already-tracked' || assessment.decision === 'fresh') return { assessment, changed: false };
  if (assessment.decision !== 'baseline-required' || assessment.supportedBaselineId === null) {
    throw new Error('Baseline assessment reached an invalid write state');
  }
  const baseline = options.contract.supportedBaselines.find((item) => item.id === assessment.supportedBaselineId);
  if (baseline === undefined) throw new Error('Matched baseline disappeared from contract');

  if (options.writeMode !== 'clone' && options.writeMode !== 'live') throw new Error('Explicit writeMode must be clone or live');
  const schemaPath = await prismaSchemaPath(options.apiDir);
  try {
    for (const migration of baseline.prismaMigrations) {
      await markMigrationApplied(options.apiDir, options.dbPath, schemaPath, migration.name);
    }
  } catch (error) {
    // `migrate resolve` is Prisma's supported way to baseline. A failure is
    // surfaced as a blocker; the updater's pre-commit rollback owns recovery.
    throw new Error(`Approved Prisma baseline write failed: ${(error as Error).message}`);
  }
  const after = await inspectPrismaHistory(options.dbPath);
  const postflight = compareHistoryToBaseline(after, baseline);
  if (after.state !== 'valid' || postflight.length > 0) {
    throw new Error('Prisma migrate resolve completed without a valid approved migration history');
  }
  return { assessment, changed: baseline.prismaMigrations.length > 0 };
}

/** Convenience helper for callers that need a redacted JSON report. */
export function baselineAssessmentJson(assessment: BaselineAssessment): JsonObject {
  return {
    ok: assessment.ok,
    decision: assessment.decision,
    schemaSha256: assessment.schemaSha256,
    supportedBaselineId: assessment.supportedBaselineId,
    legacyMappingRequired: assessment.legacyMappingRequired,
    history: {
      state: assessment.history.state,
      entries: assessment.history.entries.map((entry) => ({
        migrationName: entry.migrationName,
        checksum: entry.checksum,
        appliedStepsCount: entry.appliedStepsCount,
      })),
    },
    blockers: assessment.blockers.map(diagnosticToJson),
    warnings: assessment.warnings.map(diagnosticToJson),
  };
}

function diagnosticToJson(diagnostic: Diagnostic): JsonObject {
  return diagnostic.details === undefined
    ? { code: diagnostic.code, severity: diagnostic.severity, message: diagnostic.message }
    : { code: diagnostic.code, severity: diagnostic.severity, message: diagnostic.message, details: diagnostic.details };
}

/** Test and integration helper: validates a decoded external contract object. */
export function parseBaselineContract(value: unknown): BaselineContract {
  if (!isRecord(value)) throw new ContractError('Baseline contract must be a JSON object');
  if (value.version !== 2) throw new ContractError('Baseline contract version must be 2');
  const supportedBaselines = expectArray(value.supportedBaselines, 'supportedBaselines')
    .map((item, index) => parseSupportedBaseline(item, `supportedBaselines[${index}]`));
  assertUniqueBaselines(supportedBaselines);
  return { version: 2, supportedBaselines };
}
