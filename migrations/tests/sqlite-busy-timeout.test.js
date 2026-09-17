'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const {
  querySqliteJson,
  runSqlite,
  runSqliteScript,
} = require('../dist/release');

const LOCK_MARKER = '__MEOWBOX_SQLITE_LOCK_HELD__';

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitForChildClose(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('sqlite lock holder did not exit promptly'));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function holdWriteLock(dbPath, transaction) {
  const child = spawn('sqlite3', ['--', dbPath], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  const acquired = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`sqlite lock holder did not acquire its lock: ${stderr || 'no diagnostic'}`));
    }, 5_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`sqlite lock holder exited early (${code ?? signal ?? 'unknown'}): ${stderr || 'no diagnostic'}`));
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes(LOCK_MARKER)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
  });
  child.stdin.write(`${transaction}\nSELECT '${LOCK_MARKER}';\n`);
  await acquired;
  return child;
}

async function releaseLock(holder, statement = 'COMMIT;') {
  const closed = waitForChildClose(holder);
  holder.stdin.end(`${statement}\n`);
  const { code, signal } = await closed;
  assert.equal(signal, null, `sqlite lock holder was signalled: ${signal}`);
  assert.equal(code, 0, 'sqlite lock holder should finish its transaction');
}

async function stopHolder(holder) {
  if (holder.exitCode !== null || holder.signalCode !== null) return;
  try {
    await releaseLock(holder, 'ROLLBACK;');
  } catch {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill('SIGKILL');
  }
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'meowbox-sqlite-busy-timeout-test-'));
  const dbPath = join(root, 'meowbox.db');
  await writeFile(dbPath, '');
  await runSqliteScript(
    dbPath,
    `PRAGMA journal_mode = DELETE;
     CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
     INSERT INTO probe (value) VALUES ('initial');`,
  );
  return { root, dbPath };
}

test('release read query waits for a transient exclusive SQLite writer and succeeds', { timeout: 15_000 }, async (t) => {
  const { root, dbPath } = await createFixture();
  let holder;
  t.after(async () => {
    if (holder !== undefined) await stopHolder(holder);
    await rm(root, { recursive: true, force: true });
  });

  holder = await holdWriteLock(
    dbPath,
    "BEGIN EXCLUSIVE; INSERT INTO probe (value) VALUES ('held');",
  );
  const startedAt = Date.now();
  const query = querySqliteJson(
    dbPath,
    'SELECT COUNT(*) AS count FROM probe;',
    { timeoutMs: 4_000, busyTimeoutMs: 2_000 },
  );
  let settled = false;
  void query.then(() => { settled = true; }, () => { settled = true; });

  await delay(180);
  assert.equal(settled, false, 'read query should wait while the exclusive writer holds the database');
  await releaseLock(holder);
  holder = undefined;

  assert.deepEqual(await query, [{ count: 2 }]);
  assert.ok(Date.now() - startedAt >= 100, 'query should not complete as an immediate SQLITE_BUSY failure');
});

test('release write script waits for a transient SQLite writer and succeeds', { timeout: 15_000 }, async (t) => {
  const { root, dbPath } = await createFixture();
  let holder;
  t.after(async () => {
    if (holder !== undefined) await stopHolder(holder);
    await rm(root, { recursive: true, force: true });
  });

  holder = await holdWriteLock(
    dbPath,
    "BEGIN IMMEDIATE; UPDATE probe SET value = 'holder' WHERE id = 1;",
  );
  const write = runSqliteScript(
    dbPath,
    "BEGIN IMMEDIATE; UPDATE probe SET value = 'writer' WHERE id = 1; COMMIT;",
    { timeoutMs: 4_000, busyTimeoutMs: 2_000 },
  );
  let settled = false;
  void write.then(() => { settled = true; }, () => { settled = true; });

  await delay(180);
  assert.equal(settled, false, 'write script should wait while another writer holds the database');
  await releaseLock(holder);
  holder = undefined;

  await write;
  assert.deepEqual(await querySqliteJson(dbPath, 'SELECT value FROM probe WHERE id = 1;'), [{ value: 'writer' }]);
});

test('release SQLite busy waiting is bounded and rejects invalid budgets', { timeout: 15_000 }, async (t) => {
  const { root, dbPath } = await createFixture();
  let holder;
  t.after(async () => {
    if (holder !== undefined) await stopHolder(holder);
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(
    runSqlite(dbPath, 'SELECT 1;', { timeoutMs: 3_000, busyTimeoutMs: 2_001 }),
    /busyTimeoutMs/,
  );
  await assert.rejects(
    runSqlite(dbPath, 'SELECT 1;', { timeoutMs: 3_000, busyTimeoutMs: 1.5 }),
    /busyTimeoutMs/,
  );

  holder = await holdWriteLock(
    dbPath,
    "BEGIN EXCLUSIVE; INSERT INTO probe (value) VALUES ('still-held');",
  );
  const startedAt = Date.now();
  await assert.rejects(
    querySqliteJson(
      dbPath,
      'SELECT COUNT(*) AS count FROM probe;',
      { timeoutMs: 3_000, busyTimeoutMs: 250 },
    ),
    /database is locked/,
  );
  assert.ok(Date.now() - startedAt >= 100, 'busy handler should retry before failing closed');
});
