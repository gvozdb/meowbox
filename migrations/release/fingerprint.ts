import { quoteIdentifier, querySqliteJson } from './sqlite';
import { sha256Json, stableJson } from './stable';
import type { JsonObject, JsonValue } from './types';

export const SCHEMA_FINGERPRINT_FORMAT = 'meowbox.sqlite-schema.v1' as const;
export const DEFAULT_IGNORED_SCHEMA_OBJECTS = [
  '_prisma_migrations',
  '_meowbox_domain_migration_map',
] as const;

export interface ColumnFingerprint {
  readonly cid: number;
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly defaultValue: string | null;
  readonly primaryKeyPosition: number;
  readonly hidden: number;
}

export interface ForeignKeyFingerprint {
  readonly id: number;
  readonly sequence: number;
  readonly table: string;
  readonly from: string;
  readonly to: string | null;
  readonly onUpdate: string;
  readonly onDelete: string;
  readonly match: string;
}

export interface IndexColumnFingerprint {
  readonly sequence: number;
  readonly columnId: number;
  readonly name: string | null;
  readonly descending: boolean;
  readonly collation: string;
  readonly key: boolean;
}

export interface IndexFingerprint {
  readonly name: string;
  readonly unique: boolean;
  readonly origin: string;
  readonly partial: boolean;
  readonly sql: string | null;
  readonly columns: readonly IndexColumnFingerprint[];
}

export interface TableFingerprint {
  readonly name: string;
  readonly sql: string | null;
  readonly columns: readonly ColumnFingerprint[];
  readonly foreignKeys: readonly ForeignKeyFingerprint[];
  readonly indexes: readonly IndexFingerprint[];
}

export interface SchemaObjectFingerprint {
  readonly name: string;
  readonly sql: string | null;
}

/**
 * A structural SQLite fingerprint. `_prisma_migrations` and the temporary map
 * table are intentionally excluded: they are bookkeeping, not the legacy
 * application schema that may be baselined.
 */
export interface SchemaFingerprint {
  readonly format: typeof SCHEMA_FINGERPRINT_FORMAT;
  readonly applicationId: number;
  readonly userVersion: number;
  readonly tables: readonly TableFingerprint[];
  readonly views: readonly SchemaObjectFingerprint[];
  readonly triggers: readonly SchemaObjectFingerprint[];
}

export interface FingerprintOptions {
  readonly ignoredObjects?: readonly string[];
}

export interface FingerprintReport {
  readonly schema: SchemaFingerprint;
  readonly sha256: string;
}

function requiredString(row: JsonObject, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`SQLite schema field ${key} is missing or invalid`);
  return value;
}

function optionalString(row: JsonObject, key: string): string | null {
  const value = row[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`SQLite schema field ${key} is invalid`);
  return value;
}

function requiredNumber(row: JsonObject, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`SQLite schema field ${key} is missing or invalid`);
  }
  return value;
}

function asBoolean(value: number): boolean {
  return value !== 0;
}

async function scalarPragma(dbPath: string, pragma: 'application_id' | 'user_version'): Promise<number> {
  const rows = await querySqliteJson(dbPath, `PRAGMA ${pragma};`);
  const first = rows[0];
  if (first === undefined) throw new Error(`PRAGMA ${pragma} returned no value`);
  return requiredNumber(first, pragma);
}

async function objectSql(dbPath: string, type: 'index' | 'table' | 'trigger' | 'view', name: string): Promise<string | null> {
  const rows = await querySqliteJson(
    dbPath,
    `SELECT sql FROM sqlite_schema WHERE type = ${sqlText(type)} AND name = ${sqlText(name)};`,
  );
  return rows[0] === undefined ? null : optionalString(rows[0], 'sql');
}

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function tableFingerprint(dbPath: string, name: string, sql: string | null): Promise<TableFingerprint> {
  const quotedTable = quoteIdentifier(name);
  const [columnRows, foreignKeyRows, indexRows] = await Promise.all([
    querySqliteJson(dbPath, `PRAGMA table_xinfo(${quotedTable});`),
    querySqliteJson(dbPath, `PRAGMA foreign_key_list(${quotedTable});`),
    querySqliteJson(dbPath, `PRAGMA index_list(${quotedTable});`),
  ]);

  const columns = columnRows.map<ColumnFingerprint>((row) => ({
    cid: requiredNumber(row, 'cid'),
    name: requiredString(row, 'name'),
    type: requiredString(row, 'type'),
    notNull: asBoolean(requiredNumber(row, 'notnull')),
    defaultValue: optionalString(row, 'dflt_value'),
    primaryKeyPosition: requiredNumber(row, 'pk'),
    hidden: requiredNumber(row, 'hidden'),
  })).sort((left, right) => left.cid - right.cid);

  const foreignKeys = foreignKeyRows.map<ForeignKeyFingerprint>((row) => ({
    id: requiredNumber(row, 'id'),
    sequence: requiredNumber(row, 'seq'),
    table: requiredString(row, 'table'),
    from: requiredString(row, 'from'),
    to: optionalString(row, 'to'),
    onUpdate: requiredString(row, 'on_update'),
    onDelete: requiredString(row, 'on_delete'),
    match: requiredString(row, 'match'),
  })).sort((left, right) => left.id - right.id || left.sequence - right.sequence);

  const indexes = await Promise.all(indexRows.map(async (row): Promise<IndexFingerprint> => {
    const indexName = requiredString(row, 'name');
    const indexRowsForIndex = await querySqliteJson(dbPath, `PRAGMA index_xinfo(${quoteIdentifier(indexName)});`);
    const indexColumns = indexRowsForIndex.map<IndexColumnFingerprint>((indexRow) => ({
      sequence: requiredNumber(indexRow, 'seqno'),
      columnId: requiredNumber(indexRow, 'cid'),
      name: optionalString(indexRow, 'name'),
      descending: asBoolean(requiredNumber(indexRow, 'desc')),
      collation: requiredString(indexRow, 'coll'),
      key: asBoolean(requiredNumber(indexRow, 'key')),
    })).sort((left, right) => left.sequence - right.sequence || left.columnId - right.columnId);
    return {
      name: indexName,
      unique: asBoolean(requiredNumber(row, 'unique')),
      origin: requiredString(row, 'origin'),
      partial: asBoolean(requiredNumber(row, 'partial')),
      sql: await objectSql(dbPath, 'index', indexName),
      columns: indexColumns,
    };
  }));
  indexes.sort((left, right) => left.name.localeCompare(right.name));

  return { name, sql, columns, foreignKeys, indexes };
}

function schemaRowsToObjects(rows: readonly JsonObject[]): readonly SchemaObjectFingerprint[] {
  return rows.map((row) => ({
    name: requiredString(row, 'name'),
    sql: optionalString(row, 'sql'),
  })).sort((left, right) => left.name.localeCompare(right.name));
}

/** Read a deterministic, complete table/column/index fingerprint. */
export async function fingerprintDatabase(
  dbPath: string,
  options: FingerprintOptions = {},
): Promise<FingerprintReport> {
  const ignored = new Set(options.ignoredObjects ?? DEFAULT_IGNORED_SCHEMA_OBJECTS);
  const [applicationId, userVersion, rows] = await Promise.all([
    scalarPragma(dbPath, 'application_id'),
    scalarPragma(dbPath, 'user_version'),
    querySqliteJson(
      dbPath,
      "SELECT type, name, sql FROM sqlite_schema WHERE type IN ('table', 'view', 'trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type, name;",
    ),
  ]);
  const tables: Array<{ readonly name: string; readonly sql: string | null }> = [];
  const views: JsonObject[] = [];
  const triggers: JsonObject[] = [];
  for (const row of rows) {
    const type = requiredString(row, 'type');
    const name = requiredString(row, 'name');
    if (ignored.has(name)) continue;
    if (type === 'table') tables.push({ name, sql: optionalString(row, 'sql') });
    else if (type === 'view') views.push(row);
    else if (type === 'trigger') triggers.push(row);
  }
  tables.sort((left, right) => left.name.localeCompare(right.name));
  const tableDetails = await Promise.all(tables.map((table) => tableFingerprint(dbPath, table.name, table.sql)));
  const schema: SchemaFingerprint = {
    format: SCHEMA_FINGERPRINT_FORMAT,
    applicationId,
    userVersion,
    tables: tableDetails,
    views: schemaRowsToObjects(views),
    triggers: schemaRowsToObjects(triggers),
  };
  return { schema, sha256: fingerprintDigest(schema) };
}

export function fingerprintDigest(schema: SchemaFingerprint): string {
  return sha256Json(schema as unknown as JsonValue);
}

/** Structural equality is deliberate: digest equality alone is not a contract. */
export function sameFingerprint(left: SchemaFingerprint, right: SchemaFingerprint): boolean {
  return stableJson(left as unknown as JsonValue) === stableJson(right as unknown as JsonValue);
}
