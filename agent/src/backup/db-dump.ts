import * as fs from 'fs';
import { randomBytes } from 'crypto';
import { spawn } from 'child_process';
import { pipeline } from 'stream/promises';
import type { Readable, Writable } from 'stream';

import { CommandExecutor } from '../command-executor';
import { childProcessRegistry } from '../process-registry';

const DUMP_TIMEOUT_MS = 3_600_000;

const MAX_ERROR_BYTES = 16 * 1024;
function bounded(previous: string, chunk: Buffer): string {
  return (previous + chunk.toString('utf8')).slice(-MAX_ERROR_BYTES);
}

function pgError(stage: string, dbName: string, details: string): Error {
  const lockHint = /out of shared memory|increase max_locks_per_transaction/i.test(details)
    ? ' PostgreSQL lock table is exhausted; a consistent whole-database dump needs more lock capacity. Arrange a measured max_locks_per_transaction change and PostgreSQL restart.'
    : '';
  return new Error(`${stage} failed for ${dbName}: ${details.slice(-MAX_ERROR_BYTES)}${lockHint}`);
}

/** Stream a complete plain SQL dump into a writable sink with backpressure. */
export async function pgDumpToWritable(
  dbName: string,
  destination: Writable,
  extraArgs: string[] = [],
): Promise<void> {
  const child = spawn('sudo', ['-n', '-u', 'postgres', 'pg_dump', '-Fp', ...extraArgs, dbName], {
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    env: { PATH: process.env.PATH || '/usr/bin:/bin', LC_ALL: 'C' },
  });
  const tracked = childProcessRegistry.track(child, `pg_dump:${dbName}`, { processGroup: true });
  let stderr = '';
  let timedOut = false;
  child.stderr.on('data', (chunk: Buffer) => { stderr = bounded(stderr, chunk); });
  const exit = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(pgError('pg_dump', dbName,
        timedOut ? 'timed out while producing or uploading the dump' : stderr || `exit ${code ?? signal}`));
    });
  });
  // The deadline covers both an idle producer and a blocked consumer.
  const timer = setTimeout(() => {
    timedOut = true;
    tracked.terminate(0).catch(() => undefined);
  }, DUMP_TIMEOUT_MS);
  try {
    await Promise.all([pipeline(child.stdout, destination), exit]);
  } catch (error) {
    await tracked.terminate(0);
    await exit.catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
    tracked.untrack();
  }
}

/** Root writes a private partial in the destination directory; successful exit publishes it. */
export async function pgDumpToFile(
  _executor: CommandExecutor,
  dbName: string,
  outputPath: string,
  extraArgs: string[] = [],
): Promise<void> {
  const tmpFile = `${outputPath}.${randomBytes(8).toString('hex')}.partial`;
  const output = fs.createWriteStream(tmpFile, { flags: 'wx', mode: 0o600 });
  try {
    await pgDumpToWritable(dbName, output, extraArgs);
    // link is atomic and refuses an existing destination; rename would silently
    // replace another run's artifact if the same backup id were retried.
    await fs.promises.link(tmpFile, outputPath);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

/** Root reads a private SQL artifact and feeds postgres over stdin. */
export async function pgRestoreFromReadable(
  dbName: string,
  source: Readable,
  extraArgs: string[] = [],
  sourceVerified: Promise<void> = Promise.resolve(),
): Promise<void> {
  const child = spawn('sudo', [
    '-n', '-u', 'postgres', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-d', dbName, ...extraArgs,
  ], {
    stdio: ['pipe', 'ignore', 'pipe'], detached: true,
    env: { PATH: process.env.PATH || '/usr/bin:/bin', LC_ALL: 'C' },
  });
  const tracked = childProcessRegistry.track(child, `psql:${dbName}`, { processGroup: true });
  let stderr = '';
  let timedOut = false;
  child.stderr.on('data', (chunk: Buffer) => { stderr = bounded(stderr, chunk); });
  const exit = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(pgError('psql restore', dbName,
        timedOut ? 'timed out while restoring the dump' : stderr || `exit ${code ?? signal}`));
    });
  });
  const timer = setTimeout(() => {
    timedOut = true;
    tracked.terminate(0).catch(() => undefined);
  }, DUMP_TIMEOUT_MS);
  // The dump is transactional. Do not commit a prefix when its source fails
  // after emitting valid SQL (e.g. a late S3 download error).
  void exit.catch(() => undefined);
  void sourceVerified.catch(() => undefined);
  try {
    child.stdin.write('BEGIN;\n');
    await pipeline(source, child.stdin, { end: false });
    await sourceVerified;
    child.stdin.end('\nCOMMIT;\n');
    await exit;
  } catch (error) {
    await tracked.terminate(0);
    await exit.catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
    tracked.untrack();
  }
}

export async function pgRestoreFromFile(
  _executor: CommandExecutor,
  dbName: string,
  sourcePath: string,
  extraArgs: string[] = [],
): Promise<void> {
  await pgRestoreFromReadable(dbName, fs.createReadStream(sourcePath), extraArgs);
}

/**
 * Дамп одной БД в единый `.sql`-файл (используется и бэкапами, и restic).
 *
 * Семантика «таблицы с пропуском данных» (excludeTableData): пропускаются
 * ТОЛЬКО строки (INSERT), но НЕ структура. CREATE TABLE такой таблицы
 * выгружается всегда — иначе на восстановлении приложение упадёт на первом
 * обращении к несуществующей таблице.
 *
 * MariaDB/MySQL при наличии исключений — двухпроходно:
 *   Проход 1 (`--no-data`): структура ВСЕХ таблиц + routines + triggers.
 *     Список исключений к этому проходу НЕ применяется → пропустить CREATE
 *     физически невозможно. Пишется в outputPath.
 *   Проход 2 (`--no-create-info --skip-triggers` + `--ignore-table`): только
 *     INSERT'ы, кроме исключённых таблиц. Пишется во временный файл и
 *     потоково (без буферизации в RAM — дамп может быть гигабайтами)
 *     дописывается в конец outputPath. Порядок в файле: структура → данные.
 *
 * PostgreSQL: `pg_dump --exclude-table-data=<t>` — родной флаг, исключает
 *   ровно данные, CREATE TABLE остаётся. Один проход.
 */
export async function dumpDatabaseToFile(
  executor: CommandExecutor,
  name: string,
  type: string,
  outputPath: string,
  excludeTableData?: string[],
): Promise<void> {
  const excluded = excludeTableData?.length ? excludeTableData : [];

  if (type === 'POSTGRESQL') {
    const extra: string[] = ['--clean', '--if-exists'];
    for (const t of excluded) extra.push(`--exclude-table-data=${t}`);
    await pgDumpToFile(executor, name, outputPath, extra);
    return;
  }

  const cmd = type === 'MARIADB' ? 'mariadb-dump' : 'mysqldump';
  // result-file preserves an existing inode's mode. Create it privately before
  // invoking the database client; failed invocations must not leave plaintext.
  fs.writeFileSync(outputPath, '', { flag: 'wx', mode: 0o600 });
  try {

  // Нет исключений — один полный проход (структура + данные всех таблиц).
  if (excluded.length === 0) {
    const args = [
      '-u', 'root',
      '--single-transaction', '--quick', '--routines', '--triggers',
      `--result-file=${outputPath}`, name,
    ];
    const r = await executor.execute(cmd, args, {
      timeout: DUMP_TIMEOUT_MS,
      allowFailure: true,
    });
    if (r.exitCode !== 0) {
      throw new Error(`${cmd} failed for ${name}: ${r.stderr}`);
    }
    return;
  }

  // Проход 1 — структура ВСЕХ таблиц (вкл. исключённые) → outputPath.
  const schemaArgs = [
    '-u', 'root',
    '--no-data', '--routines', '--triggers',
    `--result-file=${outputPath}`, name,
  ];
  const rSchema = await executor.execute(cmd, schemaArgs, {
    timeout: DUMP_TIMEOUT_MS,
    allowFailure: true,
  });
  if (rSchema.exitCode !== 0) {
    throw new Error(`${cmd} schema dump failed for ${name}: ${rSchema.stderr}`);
  }

  // Проход 2 — данные кроме исключённых таблиц → временный файл.
  const dataFile = `${outputPath}.data`;
  fs.writeFileSync(dataFile, '', { flag: 'wx', mode: 0o600 });
  const dataArgs = [
    '-u', 'root',
    '--single-transaction', '--quick', '--no-create-info', '--skip-triggers',
  ];
  for (const t of excluded) dataArgs.push(`--ignore-table=${name}.${t}`);
  dataArgs.push(`--result-file=${dataFile}`, name);
  const rData = await executor.execute(cmd, dataArgs, {
    timeout: DUMP_TIMEOUT_MS,
    allowFailure: true,
  });
  if (rData.exitCode !== 0) {
    fs.rmSync(dataFile, { force: true });
    throw new Error(`${cmd} data dump failed for ${name}: ${rData.stderr}`);
  }

  // Дописываем данные после структуры — потоково, без загрузки в RAM.
  try {
    await new Promise<void>((resolve, reject) => {
      const rs = fs.createReadStream(dataFile);
      const ws = fs.createWriteStream(outputPath, { flags: 'a' });
      rs.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', resolve);
      rs.pipe(ws);
    });
  } finally {
    fs.rmSync(dataFile, { force: true });
  }
  } catch (error) {
    fs.rmSync(outputPath, { force: true });
    throw error;
  }
}
