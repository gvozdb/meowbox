import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';

import { asJsonValue } from './stable';
import type { JsonObject, JsonValue } from './types';
import { safeErrorMessage } from './redaction';

export interface SqliteOptions {
  readonly readOnly?: boolean;
  readonly timeoutMs?: number;
}

export class SqliteError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SqliteError';
  }
}

/** Quotes an SQLite identifier without relying on shell interpolation. */
export function quoteIdentifier(identifier: string): string {
  if (identifier.length === 0 || identifier.includes('\u0000')) throw new SqliteError('Invalid SQLite identifier');
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** Quotes a SQLite text literal. All caller data goes through this function. */
export function quoteLiteral(value: string | number | boolean | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SqliteError('Invalid numeric SQLite literal');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value.includes('\u0000')) throw new SqliteError('NUL is not allowed in SQLite literals');
  return `'${value.replaceAll("'", "''")}'`;
}

export async function assertReadableDatabase(dbPath: string): Promise<void> {
  if (dbPath.length === 0 || dbPath.includes('\u0000')) throw new SqliteError('Database path is invalid');
  const metadata = await stat(dbPath);
  if (!metadata.isFile()) throw new SqliteError('Database path must point to a regular file');
  await access(dbPath, constants.R_OK);
}

export async function assertWritableDatabase(dbPath: string): Promise<void> {
  await assertReadableDatabase(dbPath);
  await access(dbPath, constants.W_OK);
}

/**
 * Runs sqlite3 with stdin SQL, never via a shell. `-readonly` prevents SQLite
 * from creating journal files or accepting accidental write statements.
 */
export async function runSqlite(dbPath: string, sql: string, options: SqliteOptions = {}): Promise<string> {
  const readOnly = options.readOnly ?? true;
  if (readOnly) await assertReadableDatabase(dbPath);
  const args = ['-bail'];
  if (readOnly) args.push('-readonly');
  args.push(dbPath);

  return new Promise<string>((resolve, reject) => {
    const child = spawn('sqlite3', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, options.timeoutMs ?? 30_000);

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    child.once('error', (error) => finish(() => reject(new SqliteError(`sqlite3 could not start: ${safeErrorMessage(error)}`))));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('close', (code, signal) => {
      if (code === 0) return finish(() => resolve(stdout));
      const reason = signal === 'SIGTERM'
        ? 'sqlite3 timed out'
        : `sqlite3 failed (exit ${code ?? 'unknown'})`;
      return finish(() => reject(new SqliteError(`${reason}: ${safeErrorMessage(stderr || 'no diagnostic')}`)));
    });
    child.stdin.end(sql.endsWith('\n') ? sql : `${sql}\n`);
  });
}

export async function runSqliteScript(dbPath: string, sql: string, timeoutMs?: number): Promise<void> {
  await assertWritableDatabase(dbPath);
  await runSqlite(dbPath, sql, { readOnly: false, timeoutMs });
}

export async function querySqliteJson(dbPath: string, sql: string): Promise<readonly JsonObject[]> {
  const output = await runSqlite(dbPath, `.mode json\n${sql}`, { readOnly: true });
  const trimmed = output.trim();
  if (trimmed === '') return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(trimmed);
  } catch (error) {
    throw new SqliteError(`sqlite3 returned invalid JSON: ${safeErrorMessage(error)}`);
  }
  if (!Array.isArray(decoded)) throw new SqliteError('sqlite3 JSON result must be an array');
  return decoded.map((row, index) => {
    const value = asJsonValue(row, `sqlite row ${index}`);
    if (value === null || Array.isArray(value) || typeof value !== 'object') {
      throw new SqliteError(`sqlite row ${index} must be an object`);
    }
    return value as JsonObject;
  });
}

export function columnString(row: JsonObject, key: string): string | null {
  const value: JsonValue | undefined = row[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new SqliteError(`Expected SQLite column ${key} to be text`);
  return value;
}

export function columnNumber(row: JsonObject, key: string): number | null {
  const value: JsonValue | undefined = row[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SqliteError(`Expected SQLite column ${key} to be a finite number`);
  }
  return value;
}
