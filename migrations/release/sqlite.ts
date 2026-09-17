import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';

import { asJsonValue } from './stable';
import type { JsonObject, JsonValue } from './types';
import { safeErrorMessage } from './redaction';

/**
 * The sqlite3 process watchdog remains the final availability bound. SQLite's
 * own busy handler is intentionally shorter so a lock diagnostic is returned
 * before the process has to be terminated.
 */
export const DEFAULT_SQLITE_PROCESS_TIMEOUT_MS = 30_000;
export const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 25_000;

const SQLITE_PROCESS_TIMEOUT_GRACE_MS = 1_000;
const MAX_SQLITE_PROCESS_TIMEOUT_MS = 120_000;

export interface SqliteExecutionOptions {
  /** Maximum lifetime for the sqlite3 child process. */
  readonly timeoutMs?: number;
  /** Maximum time SQLite retries a transient busy/locked database. */
  readonly busyTimeoutMs?: number;
}

export interface SqliteOptions extends SqliteExecutionOptions {
  readonly readOnly?: boolean;
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

interface ResolvedSqliteExecutionOptions {
  readonly timeoutMs: number;
  readonly busyTimeoutMs: number;
}

function resolveSqliteExecutionOptions(options: SqliteExecutionOptions): ResolvedSqliteExecutionOptions {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SQLITE_PROCESS_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= SQLITE_PROCESS_TIMEOUT_GRACE_MS || timeoutMs > MAX_SQLITE_PROCESS_TIMEOUT_MS) {
    throw new SqliteError(
      `sqlite3 timeoutMs must be a safe integer between ${SQLITE_PROCESS_TIMEOUT_GRACE_MS + 1} and ${MAX_SQLITE_PROCESS_TIMEOUT_MS}`,
    );
  }

  const maximumBusyTimeoutMs = timeoutMs - SQLITE_PROCESS_TIMEOUT_GRACE_MS;
  const busyTimeoutMs = options.busyTimeoutMs ?? Math.min(DEFAULT_SQLITE_BUSY_TIMEOUT_MS, maximumBusyTimeoutMs);
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > maximumBusyTimeoutMs) {
    throw new SqliteError(
      `sqlite3 busyTimeoutMs must be a safe integer between 1 and ${maximumBusyTimeoutMs}`,
    );
  }
  return { timeoutMs, busyTimeoutMs };
}

/**
 * Runs sqlite3 with stdin SQL, never via a shell. The CLI busy handler retries
 * transient SQLITE_BUSY/SQLITE_LOCKED results for a bounded interval. `-readonly`
 * prevents SQLite from creating journal files or accepting accidental writes.
 */
export async function runSqlite(dbPath: string, sql: string, options: SqliteOptions = {}): Promise<string> {
  const readOnly = options.readOnly ?? true;
  const execution = resolveSqliteExecutionOptions(options);
  if (readOnly) await assertReadableDatabase(dbPath);
  // `busyTimeoutMs` is a validated integer and spawn receives an argv array,
  // so neither the database path nor SQLite configuration is shell input.
  const args = ['-bail', '-cmd', `.timeout ${execution.busyTimeoutMs}`];
  if (readOnly) args.push('-readonly');
  args.push('--', dbPath);

  return new Promise<string>((resolve, reject) => {
    const child = spawn('sqlite3', args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, execution.timeoutMs);

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

export async function runSqliteScript(
  dbPath: string,
  sql: string,
  options: SqliteExecutionOptions | number = {},
): Promise<void> {
  await assertWritableDatabase(dbPath);
  const executionOptions = typeof options === 'number' ? { timeoutMs: options } : options;
  await runSqlite(dbPath, sql, { ...executionOptions, readOnly: false });
}

export async function querySqliteJson(
  dbPath: string,
  sql: string,
  options: SqliteExecutionOptions = {},
): Promise<readonly JsonObject[]> {
  const output = await runSqlite(dbPath, `.mode json\n${sql}`, { ...options, readOnly: true });
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
