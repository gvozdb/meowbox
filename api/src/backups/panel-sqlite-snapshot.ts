import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SNAPSHOT_DEADLINE_MS = 15_000;
const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;
let snapshotQueue: Promise<unknown> = Promise.resolve();

function sqliteArgument(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function busy(error: unknown): boolean {
  return /database is locked|database is busy|SQLITE_BUSY|SQLITE_LOCKED/i.test(
    String((error as Error).message || ''),
  );
}

/** SQLite's online backup API via the sqlite3 shell; the output is never a live DB copy. */
export function createPanelSqliteSnapshot(
  dbFile: string,
  snapshotsDir: string,
): Promise<string> {
  const task = snapshotQueue.then(() => createSnapshot(dbFile, snapshotsDir));
  snapshotQueue = task.catch(() => undefined);
  return task;
}

async function createSnapshot(dbFile: string, snapshotsDir: string): Promise<string> {
  await fs.mkdir(snapshotsDir, { recursive: true, mode: 0o700 });
  const sourceSize = (await fs.stat(dbFile)).size;
  const free = await fs.statfs(snapshotsDir);
  const existing = await fs.readdir(snapshotsDir);
  let reservedBytes = 0;
  for (const file of existing.filter((name) => /^panel-run-[0-9a-f-]{36}\.db(?:\.partial)?$/.test(name))) {
    reservedBytes += (await fs.stat(path.join(snapshotsDir, file)).catch(() => ({ size: 0 }))).size;
  }
  if (sourceSize + reservedBytes > MAX_SNAPSHOT_BYTES || free.bavail * free.bsize < sourceSize * 2 + 64 * 1024 * 1024) {
    throw new Error('Insufficient reserved space for panel SQLite snapshot (512 MiB total budget)');
  }
  const remainingBudget = MAX_SNAPSHOT_BYTES - reservedBytes;
  const finalPath = path.join(snapshotsDir, `panel-run-${randomUUID()}.db`);
  const partialPath = `${finalPath}.partial`;
  const deadline = Date.now() + SNAPSHOT_DEADLINE_MS;
  try {
    for (let attempt = 0; ; attempt += 1) {
      await fs.writeFile(partialPath, '', { flag: 'wx', mode: 0o600 });
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('SQLite snapshot deadline exceeded');
        await execFileAsync('prlimit', [`--fsize=${remainingBudget}:${remainingBudget}`, '--', 'sqlite3', dbFile, '.timeout 1000', `.backup ${sqliteArgument(partialPath)}`], {
          timeout: Math.min(remaining, 5_000),
          maxBuffer: 64 * 1024,
        });
        const stat = await fs.stat(partialPath);
        if (stat.size === 0 || stat.size > remainingBudget) {
          throw new Error(`SQLite snapshot size is outside the allowed range (${stat.size} bytes)`);
        }
        const check = await execFileAsync('sqlite3', [partialPath, 'PRAGMA quick_check;'], {
          timeout: Math.min(Math.max(deadline - Date.now(), 1), 5_000),
          maxBuffer: 64 * 1024,
        });
        if (check.stdout.trim() !== 'ok') throw new Error('SQLite snapshot integrity check failed');
        await fs.chmod(partialPath, 0o600);
        await fs.rename(partialPath, finalPath);
        return finalPath;
      } catch (error) {
        await fs.rm(partialPath, { force: true });
        if (!busy(error) || attempt >= 3 || Date.now() + 200 >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100 + Math.floor(Math.random() * 100)));
      }
    }
  } catch (error) {
    await fs.rm(partialPath, { force: true });
    throw error;
  }
}
