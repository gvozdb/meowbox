#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

import {
  parseHookArguments,
  requiredAbsolutePath,
  requiredHookOption,
} from './hooks/cli';
import { safeErrorMessage } from './release/redaction';
import {
  columnNumber,
  querySqliteJson,
} from './release/sqlite';

const execFileAsync = promisify(execFile);
const TRANSACTION_RE = /^[A-Za-z0-9._-]{1,160}$/;
const PROCESS_NAMES = ['meowbox-api', 'meowbox-agent'] as const;

interface MaintenanceMarker {
  readonly version: 1;
  readonly transactionId: string;
  readonly createdAt: string;
}

interface Pm2Process {
  readonly name?: unknown;
  readonly pm2_env?: { readonly status?: unknown };
}

async function canonicalDatabase(database: string): Promise<string> {
  const metadata = await fs.stat(database);
  if (!metadata.isFile()) throw new Error('--database must point to a regular SQLite file');
  return fs.realpath(database);
}

async function markerPath(database: string): Promise<string> {
  return path.join(path.dirname(await canonicalDatabase(database)), 'migrations', 'release-maintenance.json');
}

function parseTransaction(value: string): string {
  if (!TRANSACTION_RE.test(value)) throw new Error('--transaction is invalid');
  return value;
}

async function readMarker(file: string): Promise<MaintenanceMarker | null> {
  let encoded: Buffer;
  try {
    const metadata = await fs.lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096) {
      throw new Error('release maintenance marker is unsafe');
    }
    encoded = await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const decoded = JSON.parse(encoded.toString('utf8')) as Partial<MaintenanceMarker>;
  if (decoded.version !== 1 || typeof decoded.transactionId !== 'string' || typeof decoded.createdAt !== 'string') {
    throw new Error('release maintenance marker is invalid');
  }
  return decoded as MaintenanceMarker;
}

async function writeMarker(file: string, transactionId: string): Promise<void> {
  const existing = await readMarker(file);
  if (existing) {
    if (existing.transactionId !== transactionId) {
      throw new Error(`another release transaction owns the maintenance gate`);
    }
    return;
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      const payload: MaintenanceMarker = {
        version: 1,
        transactionId,
        createdAt: new Date().toISOString(),
      };
      await handle.writeFile(`${JSON.stringify(payload)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

async function activeOperationCount(database: string): Promise<number> {
  const schemaRows = await querySqliteJson(database, `
    SELECT COUNT(*) AS table_count
    FROM sqlite_schema
    WHERE type = 'table' AND name = 'operations';
  `);
  const tableCount = schemaRows[0] ? columnNumber(schemaRows[0], 'table_count') : null;
  if (tableCount === 0) return 0;
  if (tableCount !== 1) throw new Error('could not determine operations table state');
  const rows = await querySqliteJson(database, `
    SELECT COUNT(*) AS active_count
    FROM operations
    WHERE status IN ('PENDING', 'RUNNING');
  `);
  const count = rows[0] ? columnNumber(rows[0], 'active_count') : null;
  if (count === null || !Number.isInteger(count) || count < 0) {
    throw new Error('could not determine active operation count');
  }
  return count;
}

async function executePm2(args: readonly string[]): Promise<string> {
  const result = await execFileAsync('pm2', [...args], {
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
  });
  return result.stdout;
}

async function pm2Statuses(): Promise<Map<string, string>> {
  const output = await executePm2(['jlist']);
  const decoded = JSON.parse(output) as unknown;
  if (!Array.isArray(decoded)) throw new Error('pm2 jlist returned an invalid process list');
  const statuses = new Map<string, string>();
  for (const raw of decoded as Pm2Process[]) {
    if (typeof raw.name === 'string' && typeof raw.pm2_env?.status === 'string') {
      statuses.set(raw.name, raw.pm2_env.status);
    }
  }
  return statuses;
}

async function stopPanelProcesses(): Promise<void> {
  for (const processName of PROCESS_NAMES) {
    const statuses = await pm2Statuses();
    if (!statuses.has(processName)) throw new Error(`PM2 process is missing: ${processName}`);
    if (statuses.get(processName) !== 'stopped') await executePm2(['stop', processName]);
  }
  const statuses = await pm2Statuses();
  for (const processName of PROCESS_NAMES) {
    if (statuses.get(processName) !== 'stopped') throw new Error(`PM2 process did not stop: ${processName}`);
  }
}

async function ensurePanelProcessesOnline(timeoutMs = 60_000): Promise<void> {
  let statuses = await pm2Statuses();
  for (const processName of PROCESS_NAMES) {
    if (!statuses.has(processName)) throw new Error(`PM2 process is missing: ${processName}`);
    if (statuses.get(processName) !== 'online') await executePm2(['start', processName]);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    statuses = await pm2Statuses();
    if (PROCESS_NAMES.every((processName) => statuses.get(processName) === 'online')) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('panel PM2 processes did not become online');
}

async function waitForOperations(database: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const count = await activeOperationCount(database);
    if (count === 0) return;
    if (Date.now() >= deadline) throw new Error(`${count} active operation(s) did not drain before timeout`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function removeMarker(file: string, transactionId: string): Promise<void> {
  const marker = await readMarker(file);
  if (!marker) return;
  if (marker.transactionId !== transactionId) {
    throw new Error('refusing to release a maintenance gate owned by another transaction');
  }
  await fs.unlink(file);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const arguments_ = parseHookArguments(argv, true);
    const database = requiredAbsolutePath(arguments_, 'database');
    const transactionId = parseTransaction(requiredHookOption(arguments_, 'transaction'));
    const file = await markerPath(database);

    if (arguments_.command === 'check') {
      if (await readMarker(file)) throw new Error('release maintenance gate is already active');
      const active = await activeOperationCount(database);
      if (active !== 0) throw new Error(`${active} active operation(s) block release dry-run`);
    } else if (arguments_.command === 'quiesce') {
      const timeoutRaw = arguments_.values.get('timeout') ?? '120';
      if (!/^\d+$/.test(timeoutRaw)) throw new Error('--timeout must be a positive integer');
      const timeoutMs = Number(timeoutRaw) * 1000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30 * 60_000) {
        throw new Error('--timeout must be between 1 and 1800 seconds');
      }
      await writeMarker(file, transactionId);
      await waitForOperations(database, timeoutMs);
      await stopPanelProcesses();
    } else if (arguments_.command === 'resume') {
      await ensurePanelProcessesOnline();
      await removeMarker(file, transactionId);
    } else {
      throw new Error('quiesce command must be check, quiesce or resume');
    }

    process.stdout.write(`[quiesce] ${arguments_.command} complete\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`[quiesce] ${safeErrorMessage(error)}\n`);
    return 1;
  }
}

if (require.main === module) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
