'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const hook = path.resolve(__dirname, '..', 'dist', 'quiesce.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'meowbox-quiesce-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const database = path.join(root, 'meowbox.db');
  const lockFile = path.join(root, 'release-update.lock');
  const markerDirectory = path.join(root, 'migrations');
  const markerFile = path.join(markerDirectory, 'release-maintenance.json');
  const transactionRoot = path.join(root, 'release-transactions');
  const staleTransaction = path.join(transactionRoot, 'abandoned-transaction');
  const bin = path.join(root, 'bin');
  fs.writeFileSync(database, 'sqlite-placeholder');
  fs.writeFileSync(lockFile, '');
  fs.mkdirSync(markerDirectory);
  fs.mkdirSync(staleTransaction, { recursive: true });
  fs.writeFileSync(path.join(staleTransaction, 'journal.json'), `${JSON.stringify({
    version: 1,
    transactionId: 'abandoned-transaction',
    phase: 'quiesce',
    committed: false,
    snapshotDir: null,
  })}\n`, { mode: 0o600 });
  fs.mkdirSync(bin);
  const pm2 = path.join(bin, 'pm2');
  fs.writeFileSync(pm2, [
    '#!/usr/bin/env bash',
    'if [[ "$1" == "jlist" ]]; then',
    '  printf \'[%s]\\n\' \'{"name":"meowbox-api","pm2_env":{"status":"online"}},{"name":"meowbox-agent","pm2_env":{"status":"online"}}\'',
    '  exit 0',
    'fi',
    'exit 91',
    '',
  ].join('\n'), { mode: 0o755 });
  return { root, database, lockFile, markerFile, transactionRoot, bin };
}

function writeMarker(markerFile) {
  fs.writeFileSync(markerFile, `${JSON.stringify({
    version: 1,
    transactionId: 'abandoned-transaction',
    createdAt: '2026-08-03T13:00:00.000Z',
  })}\n`, { mode: 0o600 });
}

test('stale maintenance gate is recovered only under the inherited release lock', (t) => {
  const { database, lockFile, markerFile, transactionRoot, bin } = fixture(t);
  writeMarker(markerFile);
  const script = [
    'exec 9>>"$1"',
    'flock -n 9',
    'export PATH="$2:$PATH"',
    'export MEOWBOX_RELEASE_LOCK_HELD=1',
    'export MEOWBOX_RELEASE_LOCK_FILE="$1"',
    'exec node "$3" recover-stale --transaction replacement --database "$4" --lock-file "$1" --transaction-root "$5"',
  ].join('\n');
  const result = spawnSync('bash', ['-c', script, 'recovery-test', lockFile, bin, hook, database, transactionRoot], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /recovered stale maintenance gate/);
  assert.equal(fs.existsSync(markerFile), false);
});

test('stale maintenance gate remains when release lock ownership is not proven', (t) => {
  const { database, lockFile, markerFile, transactionRoot, bin } = fixture(t);
  writeMarker(markerFile);
  const script = [
    'exec 9>&-',
    'export PATH="$1:$PATH"',
    'export MEOWBOX_RELEASE_LOCK_HELD=1',
    'export MEOWBOX_RELEASE_LOCK_FILE="$2"',
    'exec node "$3" recover-stale --transaction replacement --database "$4" --lock-file "$2" --transaction-root "$5"',
  ].join('\n');
  const result = spawnSync('bash', ['-c', script, 'recovery-test', bin, lockFile, hook, database, transactionRoot], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /release lock/);
  assert.equal(fs.existsSync(markerFile), true);
});

test('stale maintenance gate remains after the rollback boundary', (t) => {
  const { database, lockFile, markerFile, transactionRoot, bin } = fixture(t);
  writeMarker(markerFile);
  fs.writeFileSync(
    path.join(transactionRoot, 'abandoned-transaction', 'journal.json'),
    `${JSON.stringify({
      version: 1,
      transactionId: 'abandoned-transaction',
      phase: 'snapshot',
      committed: false,
      snapshotDir: '/protected/snapshot',
    })}\n`,
    { mode: 0o600 },
  );
  const script = [
    'exec 9>>"$1"',
    'flock -n 9',
    'export PATH="$2:$PATH"',
    'export MEOWBOX_RELEASE_LOCK_HELD=1',
    'export MEOWBOX_RELEASE_LOCK_FILE="$1"',
    'exec node "$3" recover-stale --transaction replacement --database "$4" --lock-file "$1" --transaction-root "$5"',
  ].join('\n');
  const result = spawnSync('bash', ['-c', script, 'recovery-test', lockFile, bin, hook, database, transactionRoot], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /not proven safe/);
  assert.equal(fs.existsSync(markerFile), true);
});
